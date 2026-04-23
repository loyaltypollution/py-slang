// Priority-scheduled worklist for analysis-graph dispatch.

import { StmtNS } from "../../ast-types";
import type { FunctionEnvironments } from "../../resolver";
import {
  unitOfNodeId,
  type Analysis,
  type AnalysisCtx,
  type Narrowing,
  type TransformRule,
  type UnitResolver,
} from "./analysis";
import {
  storeContexts,
  storeEvict,
  storeWrite,
  type FactChange,
  type ReadonlyAnalysisStore,
} from "./analysis-store";
import {
  ROOT_CONTEXT,
  type AssumptionChain
} from "./assumption-chain";
import { carrier as carrierOf, extend, without } from "./assumption-algebra";
import { clearUnitBodies } from "./assumption-bodies";
import { Retirement } from "./retirement";
import type { CounterStore } from "./counter-store";
import {
  buildFunctionRegistry,
  FunctionRegistry,
  type FunctionScopeNode,
} from "./function-registry";
import {
  buildOneUnit,
  buildUnits,
  wireCFG,
  type Unit,
} from "./function-unit";
import type { FunctionId, NodeId } from "./key-spaces";
import type { ObservationChannel } from "./observation-channel";
import { ProgramTopology } from "./topology";
// `purityBlockAnalysis` is referenced by name in `enqueueNarrowingEntry`
// (purity is not a narrowing dimension of its own, but witness discovery and
// memoization need its per-context verdicts re-seeded alongside each
// narrowing's block analysis). This import is the one residual
// framework→specific-analysis coupling; every other analysis and all
// transforms are now supplied by the caller via the constructor.
import { clearMemoId } from "../../runtime/memo";
import { directParamEntryGuardsFor, guardKeyFromGuards } from "../entry-guards";
import { purityBlockAnalysis } from "../purity-analysis/analysis";
import { memoIdFor } from "../transforms/memoization";
import type { RawKind } from "./raw-value";

class TripleQueue {
  private readonly analyses: Array<Analysis<any, any>> = [];
  private readonly keys: unknown[] = [];
  private readonly contexts: AssumptionChain[] = [];
  private head = 0;

  size(): number {
    return this.analyses.length - this.head;
  }

  push(analysis: Analysis<any, any>, key: unknown, context: AssumptionChain): void {
    this.analyses.push(analysis);
    this.keys.push(key);
    this.contexts.push(context);
  }

  /** Remove and return the head triple via out-params written into `out`.
   *  Callers read `out.analysis` / `out.key` / `out.context` and must not
   *  retain the reference — `out` is a shared scratch object. Returns true
   *  iff an item was dequeued. */
  pop(out: { analysis: Analysis<any, any>; key: unknown; context: AssumptionChain }): boolean {
    if (this.head >= this.analyses.length) return false;
    out.analysis = this.analyses[this.head];
    out.key = this.keys[this.head];
    out.context = this.contexts[this.head];
    // Null out references so dequeued entries don't pin GC roots until the
    // array is reused.
    this.analyses[this.head] = undefined as unknown as Analysis<any, any>;
    this.keys[this.head] = undefined;
    this.contexts[this.head] = undefined as unknown as AssumptionChain;
    this.head++;
    if (this.head >= this.analyses.length) {
      this.analyses.length = 0;
      this.keys.length = 0;
      this.contexts.length = 0;
      this.head = 0;
    }
    return true;
  }
}

/** Capability surface handed to evict subscribers (`onFactEvict`,
 *  `onRebuildEvict`, `onRetireEvict`). Replaces the recurring
 *  `for (const c of storeContexts(store)) storeEvict(store, key, c)` shape
 *  that every retire-edge `effect` had to spell out by hand.
 *
 *  - `evictAt` evicts a single (key, context) pair — the same operation as
 *    `ctx.evict(analysis, key)` but reachable from evict callbacks that
 *    receive an `EvictHandle` instead of an `AnalysisCtx`.
 *  - `evictAcrossContexts` enumerates every context partition the store has
 *    a cell for and evicts the key in each. Use when a unit's retirement
 *    invalidates a key irrespective of speculation chain (the common case
 *    for unit-scoped facts like purity verdicts and runtime observations). */
export interface EvictHandle {
  evictAt<K, V>(store: ReadonlyAnalysisStore<K, V>, key: K, context: AssumptionChain): void;
  evictAcrossContexts<K, V>(store: ReadonlyAnalysisStore<K, V>, key: K): void;
}

/** Singleton `EvictHandle` instance. The handle has no per-fire state — its
 *  methods are pure delegations to the framework store helpers — so there is
 *  no behavioral difference between a fresh allocation per dispatch and a
 *  shared frozen object. The dispatcher passes this same reference to every
 *  evict callback. */
const EVICT_HANDLE: EvictHandle = Object.freeze({
  evictAt<K, V>(store: ReadonlyAnalysisStore<K, V>, key: K, context: AssumptionChain): void {
    storeEvict(store, key, context);
  },
  evictAcrossContexts<K, V>(store: ReadonlyAnalysisStore<K, V>, key: K): void {
    for (const context of storeContexts(store)) storeEvict(store, key, context);
  },
});

/** Group narrowings by `observationSource`, producing both the per-source
 *  resolver map and the per-source narrowing list in one pass. Asserts each
 *  group agrees on `resolveUnit` — disagreement used to silently resolve to
 *  the first narrowing's value, landing the later narrowing's context
 *  extension on the wrong unit with no error. Throws at construction so the
 *  registration bug surfaces before any observation fires. */
function indexNarrowingsBySource(
  narrowings: ReadonlyArray<Narrowing<any, any>>,
): {
  unitResolverBySource: Map<ObservationChannel<any, RawKind>, UnitResolver<any>>;
  narrowingsBySource: Map<ObservationChannel<any, RawKind>, Narrowing<any, any>[]>;
} {
  const unitResolverBySource = new Map<ObservationChannel<any, RawKind>, UnitResolver<any>>();
  const narrowingsBySource = new Map<ObservationChannel<any, RawKind>, Narrowing<any, any>[]>();
  for (const n of narrowings) {
    const source = n.observationSource;
    if (source === undefined) continue;
    const resolver: UnitResolver<any> = n.resolveUnit ?? unitOfNodeId;
    const existing = unitResolverBySource.get(source);
    if (existing === undefined) {
      unitResolverBySource.set(source, resolver);
    } else if (existing !== resolver) {
      throw new Error(
        `[Worklist] narrowings sharing an observationSource disagree on resolveUnit — all narrowings on one source must resolve to the same unit.`,
      );
    }
    const group = narrowingsBySource.get(source);
    if (group === undefined) narrowingsBySource.set(source, [n]);
    else group.push(n);
  }
  return { unitResolverBySource, narrowingsBySource };
}

export class Worklist {
  /** Single source of truth for every cross-unit index — scope-node → unit,
   *  functionId → unit, nodeId → {unit, block}. Replaces the worklist's old
   *  `_units`, `unitsByFunctionId`, and `nodeToUnit` maps, and the per-unit
   *  `blockOfNode` field that used to live on `Unit`. */
  private readonly _topology = new ProgramTopology();

  /** Units awaiting CFG rebuild after a transform fire. */
  private readonly pendingRebuilds = new Set<Unit>();

  private readonly changeListeners: Array<(change: FactChange<unknown, unknown>) => void> = [];
  /** Ordered dispatch list for cross-store sweeps. Registration order is
   *  observable and must be stable, so this stays an array. The parallel
   *  `Set` exists solely as an O(1) idempotency guard on `register`. */
  private readonly registeredAnalyses: Analysis<any, any>[] = [];
  private readonly registeredAnalysesSet = new Set<Analysis<any, any>>();
  // Two tier-specific FIFOs in place of a priority queue: the only
  // previously-enforced order was `tier(runtime) < tier(analysis)` with
  // FIFO-within-tier. Split queues give us O(1) dequeue without a heap
  // wrapper per item and let us drop the per-enqueue `seq` field.
  private readonly runtimeQueue = new TripleQueue();
  private readonly analysisQueue = new TripleQueue();
  /** Scratch object reused by `TripleQueue.pop` — avoids allocating a result
   *  object per dequeue. Fields are overwritten on every pop. */
  private readonly dequeued: { analysis: Analysis<any, any>; key: unknown; context: AssumptionChain } = {
    analysis: undefined as unknown as Analysis<any, any>,
    key: undefined,
    context: undefined as unknown as AssumptionChain,
  };
  /** Dedup guard: a given (analysis, context, key) enqueued twice before being
   *  drained is a single item. Context is part of the dedup identity because
   *  sibling contexts run independent Kildall. */
  private readonly pendingKeysByAnalysis = new Map<
    Analysis<any, any>,
    Map<AssumptionChain, Set<unknown>>
  >();

  /** Registered transforms and their dirty sets. A unit enters the dirty set
   *  on mint, rebuild, or a write to an upstream analysis the rule subscribes
   *  to; sweep clears it. */
  private readonly transforms: TransformRule[] = [];
  private readonly transformsSet = new Set<TransformRule>();
  private readonly transformDirty = new Map<TransformRule, Set<Unit>>();

  /** Reentrancy guard: set while `sweepTransforms` runs. `publish` and `bump`
   *  throw when this is true — online observation ingress during a transform
   *  sweep would widen/narrow `futureDispatchChainFor(unit)` under the
   *  sweep's feet, causing transforms to generate code against a chain that
   *  has already moved. Today no caller does this (observations fire outside
   *  drain, driven by the evaluator before/after engine dispatch); the guard
   *  converts that social invariant into a loud crash the first time someone
   *  wires mid-sweep observation. */
  private inTransformSweep = false;

  /** Per-unit scheduler / future-dispatch speculation context. Updated from
   *  runtime observations and widen operations so future compiles / dispatches
   *  have a preferred chain to read from. This is NOT a faithful model of all
   *  currently executing frames for the unit — evaluators track active-frame
   *  provenance separately. Unset or ROOT_CONTEXT means future dispatch is
   *  currently unspecialized for that unit. */
  private readonly futureDispatchContext: Map<Unit, AssumptionChain> = new Map();

  /** Single fact-change dispatch index. Analyses and transforms both compile
   *  their fact subscriptions into callbacks here; no per-subscriber-kind
   *  branching lives in `handleFactChange`. */
  private readonly factSubs = new Map<
    Analysis<any, any>,
    Array<(ctx: AnalysisCtx, key: unknown) => void>
  >();
  /** Per-counter bump dispatch index. Parallel to `factSubs` but keyed by
   *  `CounterStore` identity. Counter bumps have no context; subscribers
   *  receive the ROOT-rooted `passCtx` for topology access. */
  private readonly counterSubs = new Map<
    CounterStore<any>,
    Array<(ctx: AnalysisCtx, key: unknown) => void>
  >();
  private readonly registeredCounters: CounterStore<any>[] = [];
  private readonly registeredCountersSet = new Set<CounterStore<any>>();
  /** Per-channel publish dispatch index. Parallel to `factSubs` but keyed
   *  by `ObservationChannel` identity. Subscribers fire on
   *  `Worklist.publish` under the publication chain's `AnalysisCtx`. */
  private readonly channelSubs = new Map<
    ObservationChannel<any, any>,
    Array<(ctx: AnalysisCtx, key: unknown) => void>
  >();
  /** Lifecycle dispatch indices, one array per event kind. Analyses' typed
   *  lifecycle subscriptions and transforms' mint/rebuild auto-dirtying both
   *  compile into callbacks on these lists. `specRev` is the internal name
   *  for the public `onSpecRev` event (future-dispatch context revision). */
  private readonly mintSubs: Array<(ctx: AnalysisCtx, unit: Unit) => void> = [];
  private readonly rebuildSubs: Array<(ctx: AnalysisCtx, unit: Unit) => void> = [];
  private readonly retireSubs: Array<(ctx: AnalysisCtx, unit: Unit) => void> = [];
  private readonly specRevSubs: Array<(ctx: AnalysisCtx, unit: Unit) => void> = [];

  /** Retirement filter. Stores minimal generators; `isRetired(c)` is the
   *  algebraic-membership check `∃ r ∈ R. leq(r, c)`. Correct for
   *  rebuild-path supersets that parent-walk ancestry would miss.
   *  Monotone: once a generator is retired it stays retired for the life
   *  of the worklist. */
  private readonly retirement: Retirement = new Retirement();

  readonly registry: FunctionRegistry;
  private readonly functionEnvironments: FunctionEnvironments;

  /** Readonly projection of the topology — the surface consumers (DfaQuery,
   *  transforms outside the worklist, backends, tests) read through. */
  get topology(): ProgramTopology {
    return this._topology;
  }

  get units(): ReadonlyMap<FunctionId, Unit> {
    return this._topology.units;
  }

  /** The engine's root chain — the "no assumptions" reading position.
   *  External consumers (backends, ROOT-keyed profile reads) take this from
   *  the engine instead of importing `ROOT_CONTEXT` directly, so the
   *  framework stays the only place that names the symbol. */
  get rootChain(): AssumptionChain {
    return ROOT_CONTEXT;
  }

  /** Registered speculation-narrowing dimensions. The observation translator
   *  iterates this list — adding a new narrowing is a one-line registration
   *  here, not a framework edit. */
  private readonly narrowings: ReadonlyArray<Narrowing<any, any>>;

  /** Per-observation-source unit resolver, derived from `narrowings` at
   *  construction. All narrowings sharing an `observationSource` must
   *  agree on `resolveUnit` — the observation translator uses a single
   *  resolver per source; disagreement used to silently resolve via the
   *  first narrowing's value, leaving the later narrowing's context
   *  extension to land on the wrong unit with no error. */
  private readonly unitResolverBySource: Map<
    ObservationChannel<any, RawKind>,
    UnitResolver<any>
  >;

  /** Index of narrowings by `observationSource`, derived from `narrowings` at
   *  construction. Replaces O(m) filter on every observation with O(1) lookup. */
  private readonly narrowingsBySource: ReadonlyMap<
    ObservationChannel<any, RawKind>,
    ReadonlyArray<Narrowing<any, any>>
  >;

  private readonly registeredChannels: ObservationChannel<any, any>[] = [];
  private readonly registeredChannelsSet = new Set<ObservationChannel<any, any>>();

  constructor(
    ast: StmtNS.FileInput,
    functionEnvironments: FunctionEnvironments,
    analyses: ReadonlyArray<Analysis<any, any>>,
    registry: FunctionRegistry | undefined,
    transforms: ReadonlyArray<TransformRule>,
    narrowings: ReadonlyArray<Narrowing<any, any>> = [],
    counters: ReadonlyArray<CounterStore<any>> = [],
    channels: ReadonlyArray<ObservationChannel<any, any>> = [],
  ) {
    this.narrowings = narrowings;
    const indexed = indexNarrowingsBySource(narrowings);
    this.unitResolverBySource = indexed.unitResolverBySource;
    this.narrowingsBySource = indexed.narrowingsBySource;
    this.registry = registry ?? buildFunctionRegistry(ast);
    this.functionEnvironments = functionEnvironments;
    const built = buildUnits(ast, functionEnvironments, this.registry);
    for (const [, unit] of built) {
      if (!this.registry.hasNode(unit.funcAst)) {
        throw new Error(
          `[Worklist] unit for functionId=${unit.funcAst.id} missing from FunctionRegistry — registry likely built from a different AST`,
        );
      }
      this._topology.registerUnit(unit);
    }

    for (const p of analyses) this.register(p);
    for (const c of counters) this.registerCounter(c);
    for (const ch of channels) this.registerChannel(ch);
    for (const r of transforms) this.registerTransform(r);
    // The observation→context translator hooks directly into `observe`, not
    // via the change-listener list — an eq-gated write short-circuits
    // repeated same-value writes (the monotone fast path), and count-based
    // policies need to see every call, not every lattice change.

    // Initial units are seeded lazily: `register` replays onUnitMinted to each
    // analysis's subscriber, and `registerTransform` populates each rule's dirty
    // set with the existing units. Subsequent mints (mid-drain) fire
    // onUnitMinted via `onRegistryMint`.

    this.registry.setListener({
      onMint: (node, slot) => this.onRegistryMint(node, slot),
      onRetire: (functionId, node) => this.onRegistryRetire(functionId, node),
    });
  }

  private onRegistryMint(node: FunctionScopeNode, _slot: number): void {
    if (!(node instanceof StmtNS.FunctionDef)) return;
    const unit = buildOneUnit(node, this.functionEnvironments, this.registry);
    this._topology.registerUnit(unit);
    this.fireMint(unit);
  }

  private onRegistryRetire(functionId: FunctionId, _node: FunctionScopeNode): void {
    const unit = this._topology.unitOfFunctionId(functionId);
    if (unit === undefined) return;
    this.pendingRebuilds.delete(unit);
    this.futureDispatchContext.delete(unit);
    for (const s of this.transformDirty.values()) s.delete(unit);
    clearUnitBodies(unit);
    // Each analysis declares its own eviction via `{on:"retire", effect}`.
    // Fire lifecycle BEFORE dropping topology indices so retire effects that
    // walk `topology.nodesOfUnit(unit)` still see the unit's nodes.
    this.fireRetire(unit);
    this._topology.unregisterUnit(unit);
  }

  /** Return `rule`'s dirty set, asserting it exists. `registerTransform` is
   *  the only site that populates this map; call sites that touch it outside
   *  that function go through here so the invariant is named. */
  private dirtyFor(rule: TransformRule): Set<Unit> {
    const s = this.transformDirty.get(rule);
    if (s === undefined) {
      throw new Error(`[Worklist] transform has no dirty set — missed registerTransform?`);
    }
    return s;
  }

  private fireMint(unit: Unit): void {
    for (const sub of this.mintSubs) sub(this.passCtx, unit);
  }
  private fireRebuild(unit: Unit): void {
    for (const sub of this.rebuildSubs) sub(this.passCtx, unit);
  }
  private fireRetire(unit: Unit): void {
    for (const sub of this.retireSubs) sub(this.passCtx, unit);
  }
  private fireSpecRev(unit: Unit): void {
    for (const sub of this.specRevSubs) sub(this.passCtx, unit);
  }

  /** `c` is retired iff any retired generator is an algebraic subset.
   *  Safe to call with ROOT (always false). */
  isRetired(node: AssumptionChain): boolean {
    return this.retirement.isRetired(node);
  }

  /** Retire `carrier` for `unit`: add it to the retirement filter, clear
   *  the memo bucket minted against its direct-param entry guards, and
   *  drop `futureDispatchContext[unit]` if it now points into the
   *  retired subtree (algebraic check — not just pointwise equality).
   *  Body eviction is lazy: retirement-aware `visibleBody` skips retired
   *  ancestors on future reads; stale forks are reclaimed when the unit
   *  releases. Idempotent. */
  private retireChain(unit: Unit, carrier: AssumptionChain): void {
    if (carrier === ROOT_CONTEXT) return;
    this.retirement.retire(carrier);
    const fd = unit.funcAst;
    if (fd instanceof StmtNS.FunctionDef) {
      clearMemoId(memoIdFor(fd, guardKeyFromGuards(directParamEntryGuardsFor(unit, carrier))));
    }
    const fdCtx = this.futureDispatchContext.get(unit);
    if (fdCtx !== undefined && this.retirement.isRetired(fdCtx)) {
      this.futureDispatchContext.delete(unit);
    }
  }


  /** Subscribe `fn` to writes against `upstream`. Called via `register` /
   *  `registerTransform`; not public API. */
  private subscribeFact(
    upstream: Analysis<any, any>,
    fn: (ctx: AnalysisCtx, key: unknown) => void,
  ): void {
    const list = this.factSubs.get(upstream) ?? [];
    list.push(fn);
    this.factSubs.set(upstream, list);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Typed `on*` subscribe methods. Each (event, kind) is its own method with
  // mandatory parameters — no Subscription wrapper, no exported Event enum,
  // no optional-pair fields. Each method appends to `factSubs` / the per-kind
  // lifecycle lists directly; dispatch is O(1).
  //
  //   factWrite  → onFactDirty    + onFactEvict
  //   mint       → onMint
  //   rebuild    → onRebuildDirty + onRebuildEvict
  //   retire     → onRetireEvict
  //   specRev    → onSpecRev
  // ─────────────────────────────────────────────────────────────────────────

  /** Subscribe `reader` to dirtied keys yielded when `from` advances at any
   *  key. `dirtied(ctx, key)` projects the upstream key-change into this
   *  reader's key space; each yielded key is enqueued for `reader`'s
   *  transfer.
   *
   *  `opts.enqueueAt` projects the source context into the enqueue context.
   *  Default: enqueue at the same context the upstream write happened in
   *  (`ctx.currentContext`). Use `enqueueAt: () => ROOT_CONTEXT` for
   *  context-blind consumers whose cells exist only at ROOT — waking them
   *  in a non-ROOT context would write into an orphan cell no reader ever
   *  consults. */
  onFactDirty<K>(
    from: Analysis<any, any>,
    reader: Analysis<K, any>,
    dirtied: (ctx: AnalysisCtx, key: unknown) => Iterable<K>,
    opts?: { enqueueAt?: (sourceCtx: AssumptionChain) => AssumptionChain },
  ): void {
    const project = opts?.enqueueAt;
    this.subscribeFact(from, (ctx, key) => {
      const enqueueCtx = project !== undefined ? project(ctx.currentContext) : ctx.currentContext;
      for (const k of dirtied(ctx, key)) this.enqueue(reader, k, enqueueCtx);
    });
  }

  /** Subscribe an evict callback to writes against `from`. Used by analyses
   *  whose stored cells must be invalidated (not merely re-dirtied) when an
   *  upstream fact advances — e.g. block-DFA cells under a stale narrowing
   *  whose monotone join would absorb the new fact. The handle exposes
   *  `evictAt` and `evictAcrossContexts` so callers don't reimplement the
   *  `storeContexts` loop. */
  onFactEvict(
    from: Analysis<any, any>,
    evict: (h: EvictHandle, key: unknown) => void,
  ): void {
    this.subscribeFact(from, (_ctx, key) => evict(EVICT_HANDLE, key));
  }

  /** Subscribe `reader` to mint of any unit. `dirtied(ctx, unit)` yields
   *  keys for `reader` to enqueue. Fires immediately against every
   *  existing unit at registration so late subscribers pick up the initial
   *  burst. */
  onMint<K>(
    reader: Analysis<K, any>,
    dirtied: (ctx: AnalysisCtx, unit: Unit) => Iterable<K>,
  ): void {
    this.mintSubs.push((_ctx, unit) => {
      for (const k of dirtied(this.passCtx, unit)) this.enqueue(reader, k, ROOT_CONTEXT);
    });
    // Replay against existing units so registration order does not determine
    // seeding.
    for (const unit of this._topology.units.values()) {
      for (const k of dirtied(this.passCtx, unit)) this.enqueue(reader, k, ROOT_CONTEXT);
    }
  }

  /** Subscribe `reader` to rebuild of any unit. Distinct method (rather than
   *  shared with mint) because rebuild-time invalidation often needs a paired
   *  `onRebuildEvict` to drop stale block-keyed cells before the fresh CFG
   *  is wired — the matrix calls these out as two independent concerns. */
  onRebuildDirty<K>(
    reader: Analysis<K, any>,
    dirtied: (ctx: AnalysisCtx, unit: Unit) => Iterable<K>,
  ): void {
    this.rebuildSubs.push((_ctx, unit) => {
      for (const k of dirtied(this.passCtx, unit)) this.enqueue(reader, k, ROOT_CONTEXT);
    });
  }

  /** Subscribe an evict callback to rebuild. Typically used to drop block-
   *  keyed cells whose `BasicBlock` identities belong to the pre-rebuild
   *  CFG generation. */
  onRebuildEvict(evict: (h: EvictHandle, unit: Unit) => void): void {
    this.rebuildSubs.push((_ctx, unit) => evict(EVICT_HANDLE, unit));
  }

  /** Subscribe an evict callback to retire. The matrix is evict-only here:
   *  dirtying keys against a retiring unit is meaningless (no transfer will
   *  ever consume them), and cross-unit invalidation triggered by retirement
   *  is the job of fact subscriptions, not the retire hook. */
  onRetireEvict(evict: (h: EvictHandle, unit: Unit) => void): void {
    this.retireSubs.push((_ctx, unit) => evict(EVICT_HANDLE, unit));
  }

  /** Subscribe `reader` to spec-context bumps on any unit. Fires when
   *  observation-driven extension mutates `futureDispatchContext`. No paired
   *  evict — a context bump advances no facts, so subscribers whose output
   *  is gated on `futureDispatchChainFor(unit)` simply re-enqueue their
   *  key. */
  onSpecRev<K>(
    reader: Analysis<K, any>,
    dirtied: (ctx: AnalysisCtx, unit: Unit) => Iterable<K>,
  ): void {
    this.specRevSubs.push((_ctx, unit) => {
      for (const k of dirtied(this.passCtx, unit)) this.enqueue(reader, k, ROOT_CONTEXT);
    });
  }

  /** Register an analysis. Idempotent. Analyses subscribe through `bind` and
   *  the typed `on*` methods; the legacy declarative edge surface is gone. */
  register<K, V>(analysis: Analysis<K, V>): void {
    const a = analysis as Analysis<any, any>;
    if (this.registeredAnalysesSet.has(a)) return;
    this.registeredAnalysesSet.add(a);
    this.registeredAnalyses.push(a);
    analysis.bind?.(this);
  }

  /** Register a transform rule. Idempotent. Auto-installs mint/rebuild dirtying
   *  for the rule's own unit (every production transform wants this; no rule
   *  currently opts out), then lets the rule subscribe via `bind`. */
  registerTransform(rule: TransformRule): void {
    if (this.transformsSet.has(rule)) return;
    this.transformsSet.add(rule);
    this.transforms.push(rule);
    const dirty = new Set<Unit>();
    for (const u of this._topology.units.values()) dirty.add(u);
    this.transformDirty.set(rule, dirty);

    const addUnit = (_ctx: AnalysisCtx, unit: Unit): void => { dirty.add(unit); };
    this.mintSubs.push(addUnit);
    this.rebuildSubs.push(addUnit);
    rule.bind?.(this);
  }

  /** Public mutator for a transform's dirty set. The transform is identified
   *  by reference (the same `TransformRule` value passed to `registerTransform`).
   *  Used by `bind`-driven subscribers that need to mark a unit dirty without
   *  reaching into the worklist's private `transformDirty` map. */
  dirtyTransform(rule: TransformRule, unit: Unit): void {
    this.dirtyFor(rule).add(unit);
  }

  /** Subscribe `rule` to writes against `from`. Mirror of `onFactDirty` for
   *  transforms — `dirtied(ctx, key)` yields units to add to the rule's
   *  dirty set. Appends to the same `factSubs` index as analysis readers, so
   *  per-upstream registration order remains observable via
   *  `handleFactChange` iteration. */
  onTransformFactDirty<K>(
    rule: TransformRule,
    from: Analysis<K, any>,
    dirtied: (ctx: AnalysisCtx, key: K) => Iterable<Unit>,
  ): void {
    const dirty = this.dirtyFor(rule);
    this.subscribeFact(from as Analysis<any, any>, (ctx, key) => {
      for (const u of dirtied(ctx, key as K)) dirty.add(u);
    });
  }

  /** Register a counter. Idempotent. Counters subscribe through `bind` and
   *  the typed `onCounter*` methods; mirrors the Analysis registration path. */
  registerCounter<K>(counter: CounterStore<K>): void {
    const c = counter as CounterStore<any>;
    if (this.registeredCountersSet.has(c)) return;
    this.registeredCountersSet.add(c);
    this.registeredCounters.push(c);
    counter.bind?.(this);
  }

  /** Append a counter-bump subscriber. Private; the typed `onCounter*`
   *  methods call through here. */
  private subscribeCounter(
    counter: CounterStore<any>,
    fn: (ctx: AnalysisCtx, key: unknown) => void,
  ): void {
    const list = this.counterSubs.get(counter) ?? [];
    list.push(fn);
    this.counterSubs.set(counter, list);
  }

  /** Increment `counter[key]` by 1, clamped at `counter.saturation`. Fires
   *  subscribers on advancing bumps; post-saturation bumps are no-ops (no
   *  dispatch, no fixpoint drain). Analogous to `publish` for observation
   *  channels, minus the lattice and narrowing extension. */
  bump<K>(counter: CounterStore<K>, key: K): void {
    if (this.inTransformSweep) {
      throw new Error(
        `[Worklist.bump] called during transform sweep. ` +
        `Observation ingress must fire outside drain — mid-sweep bumps can shift subscribers ` +
        `while rules are reading them.`,
      );
    }
    const r = counter._applyBump(key);
    if (r === null) return;
    const subs = this.counterSubs.get(counter as CounterStore<any>);
    if (subs !== undefined) {
      for (const s of subs) s(this.passCtx, key);
    }
    this.processAnalysesToFixpoint();
  }

  /** Subscribe `reader` to bumps on `counter`. `dirtied(ctx, key)` projects
   *  the counter key into the reader's key space; yielded keys enqueue under
   *  ROOT_CONTEXT (counters have no context, and reader cells driven by
   *  profile evidence live at ROOT). */
  onCounterBumped<K, K2>(
    counter: CounterStore<K>,
    reader: Analysis<K2, any>,
    dirtied: (ctx: AnalysisCtx, key: K) => Iterable<K2>,
  ): void {
    this.subscribeCounter(counter as CounterStore<any>, (ctx, key) => {
      for (const k of dirtied(ctx, key as K)) this.enqueue(reader, k, ROOT_CONTEXT);
    });
  }

  /** Mirror of `onCounterBumped` for transforms — `dirtied(ctx, key)` yields
   *  units to add to the rule's dirty set. */
  onTransformCounterBumped<K>(
    rule: TransformRule,
    counter: CounterStore<K>,
    dirtied: (ctx: AnalysisCtx, key: K) => Iterable<Unit>,
  ): void {
    const dirty = this.dirtyFor(rule);
    this.subscribeCounter(counter as CounterStore<any>, (ctx, key) => {
      for (const u of dirtied(ctx, key as K)) dirty.add(u);
    });
  }

  /** Public read surface for tests and backends that hold a Worklist but
   *  not a specific Analysis reference's store. Thin delegation to the
   *  analysis's canonical read methods. `context` is mandatory on every
   *  helper: `Context` is the primitive, ROOT is one tree-root position
   *  inside it, and the worklist does not guess which position a caller
   *  meant. */
  read<K, V>(analysis: Analysis<K, V>, key: K, context: AssumptionChain): V {
    return analysis.read(key, context);
  }
  tryRead<K, V>(analysis: Analysis<K, V>, key: K, context: AssumptionChain): V | undefined {
    return analysis.tryRead(key, context);
  }
  readAll<K, V>(analysis: Analysis<K, V>, context: AssumptionChain): ReadonlyMap<K, V> {
    return analysis.readAll(context);
  }
  /** Writes through `analysis.store` AND publishes a `FactChange` to
   *  every subscriber — the single advancing-write site alongside
   *  `writeAndDispatch` (which is private, reused by `observe` and
   *  transfer-result handling). Returns `true` iff the cell advanced. */
  write<K, V>(
    analysis: Analysis<K, V>,
    key: K,
    value: V,
    context: AssumptionChain,
  ): boolean {
    return this.writeAndDispatch(analysis, key, value, context);
  }
  evict<K, V>(analysis: Analysis<K, V>, key: K, context: AssumptionChain): void {
    storeEvict(analysis.store, key, context);
  }

  /** Record a runtime observation made under `context`. The caller — typically
   *  the JIT observation adapter (`makeJitObservers`) — passes the running
   *  frame's current provenance chain. Top-level observations with no
   *  enclosing specialized frame pass `ROOT_CONTEXT`.
   *
   *  Two side effects:
   *  1. `channel` shadow-writes `value` at `context` (for dedup).
   *  2. `handleObservationForSpec` runs, extending or pruning the owning
   *     unit's speculation context via every narrowing whose
   *     `observationSource === channel`.
   *
   *  Returns the caller's next frame-local provenance chain (extended or
   *  pruned). The shadow write lands at the incoming `context` regardless. */
  publish<K>(
    channel: ObservationChannel<K, RawKind>,
    key: K,
    value: RawKind,
    context: AssumptionChain,
  ): AssumptionChain {
    if (this.inTransformSweep) {
      throw new Error(
        `[Worklist.publish] called during transform sweep. ` +
        `Observations extend futureDispatchChainFor(unit); allowing them mid-sweep ` +
        `means rules generate code against a chain that has already widened.`,
      );
    }
    channel._writeShadow(context, key, value);
    const subs = this.channelSubs.get(channel as ObservationChannel<any, any>);
    if (subs !== undefined) {
      const publishCtx = this.ctxFor(context);
      for (const s of subs) s(publishCtx, key);
    }
    const nextContext = this.handleObservationForSpec(channel, key, value, context);
    this.processAnalysesToFixpoint();
    return nextContext;
  }

  /** Register a channel. Idempotent. Mirrors `register` / `registerCounter`. */
  registerChannel<K, V>(channel: ObservationChannel<K, V>): void {
    const c = channel as ObservationChannel<any, any>;
    if (this.registeredChannelsSet.has(c)) return;
    this.registeredChannelsSet.add(c);
    this.registeredChannels.push(c);
    channel.bind?.(this);
  }

  /** Append a channel-publish subscriber. Private; typed `onChannel*`
   *  methods go through here. */
  private subscribeChannel(
    channel: ObservationChannel<any, any>,
    fn: (ctx: AnalysisCtx, key: unknown) => void,
  ): void {
    const list = this.channelSubs.get(channel) ?? [];
    list.push(fn);
    this.channelSubs.set(channel, list);
  }

  /** Subscribe `reader` to publishes on `channel`. `dirtied(ctx, key)`
   *  projects the channel key into the reader's key space; yielded keys
   *  enqueue at the publication chain (or `opts.enqueueAt(chain)` if the
   *  reader's cells live in a different context tree position). */
  onChannelPublished<K, K2>(
    channel: ObservationChannel<K, any>,
    reader: Analysis<K2, any>,
    dirtied: (ctx: AnalysisCtx, key: K) => Iterable<K2>,
    opts?: { enqueueAt?: (sourceCtx: AssumptionChain) => AssumptionChain },
  ): void {
    const project = opts?.enqueueAt;
    this.subscribeChannel(channel as ObservationChannel<any, any>, (ctx, key) => {
      const enqueueCtx = project !== undefined ? project(ctx.currentContext) : ctx.currentContext;
      for (const k of dirtied(ctx, key as K)) this.enqueue(reader, k, enqueueCtx);
    });
  }

  /** Mirror of `onChannelPublished` for transforms. */
  onTransformChannelPublished<K>(
    rule: TransformRule,
    channel: ObservationChannel<K, any>,
    dirtied: (ctx: AnalysisCtx, key: K) => Iterable<Unit>,
  ): void {
    const dirty = this.dirtyFor(rule);
    this.subscribeChannel(channel as ObservationChannel<any, any>, (ctx, key) => {
      for (const u of dirtied(ctx, key as K)) dirty.add(u);
    });
  }

  hasPendingWork(): boolean {
    if (this.runtimeQueue.size() > 0 || this.analysisQueue.size() > 0) return true;
    if (this.pendingRebuilds.size > 0) return true;
    for (const s of this.transformDirty.values()) if (s.size > 0) return true;
    return false;
  }

  enqueue<K, V>(analysis: Analysis<K, V>, key: K, context: AssumptionChain): void {
    const p = analysis as Analysis<any, any>;
    let byContext = this.pendingKeysByAnalysis.get(p);
    if (byContext === undefined) {
      byContext = new Map();
      this.pendingKeysByAnalysis.set(p, byContext);
    }
    let pending = byContext.get(context);
    if (pending === undefined) {
      pending = new Set();
      byContext.set(context, pending);
    }
    if (pending.has(key)) return;
    pending.add(key);
    const q = p.tier === "runtime" ? this.runtimeQueue : this.analysisQueue;
    q.push(p, key, context);
  }

  /** Drain the analysis PQ to empty. Tier order: runtime < analysis.
   *  Boundary: after return, every analysis cell is at its current fixed
   *  point for the enqueued work; transforms have NOT been swept and CFG
   *  rebuilds have NOT fired. Callers needing transform/rebuild publication
   *  must invoke `drain()`. */
  private processAnalysesToFixpoint(): void {
    // Runtime-tier items preempt analysis-tier items: on every iteration
    // pull from the runtime queue first, and only fall through to analysis
    // once it is empty. A fresh runtime enqueue mid-drain (e.g. a transfer
    // that publishes an observation) is picked up on the next iteration,
    // matching the old PriorityQueue's preemption semantics.
    const out = this.dequeued;
    while (this.runtimeQueue.size() > 0 || this.analysisQueue.size() > 0) {
      const dequeued = this.runtimeQueue.size() > 0
        ? this.runtimeQueue.pop(out)
        : this.analysisQueue.pop(out);
      if (!dequeued) break;
      const analysis = out.analysis;
      const key = out.key;
      const context = out.context;
      this.pendingKeysByAnalysis.get(analysis)?.get(context)?.delete(key);
      const ctx = this.ctxFor(context);
      const value = analysis.transfer(ctx, key);
      if (value !== undefined) {
        this.writeAndDispatch(analysis, key, value, context);
      }
    }
  }

  /** Write via the framework-owned store helper and publish a `FactChange`
   *  to every listener registered on `factSubs`. This is the single site that
   *  funnels transfer results into the cell + fans them out to subscribers. */
  private writeAndDispatch<K, V>(
    analysis: Analysis<K, V>,
    key: K,
    value: V,
    context: AssumptionChain,
  ): boolean {
    const result = storeWrite(analysis.store, key, value, context);
    if (result === null) return false;
    // Skip the FactChange literal allocation when nobody is listening:
    // channels with no narrowing reader and counters' paired shadow writes
    // land here millions of times during a hot loop; the object allocated
    // only to be read by `handleFactChange`'s early-return is pure churn.
    const subs = this.factSubs.get(analysis as Analysis<any, any>);
    if (subs === undefined && this.changeListeners.length === 0) return true;
    this.handleFactChange({
      analysis: analysis as Analysis<unknown, unknown>,
      key,
      context,
      oldValue: result.prev,
      newValue: result.next,
    });
    return true;
  }

  /** Sweep every registered transform over its dirty units once. Units that
   *  rewrote move to `pendingRebuilds`; CFG rebuild is NOT flushed here —
   *  that happens in `drain()`'s outer loop or on the next explicit drain.
   *
   *  Public so online participants (notably `jitAnalysis` in the JIT
   *  evaluator) can run counter-/fact-driven transforms — memoization being
   *  the canonical case — before emitting new bytecode. The caller is
   *  responsible for ordering: invoke after the analyses this rule depends
   *  on have settled at the relevant chain. Returns true iff any rule fired. */
  sweepTransforms(): boolean {
    let anyFired = false;
    this.inTransformSweep = true;
    try {
      for (const r of this.transforms) {
        const dirty = this.dirtyFor(r);
        if (dirty.size === 0) continue;
        // Iterate directly without an `Array.from` snapshot. `dirty` cannot
        // grow during iteration: `TransformRule.sweep(unit, chain, topology)`
        // receives no worklist or AnalysisCtx, so no sweep body can reach
        // `writeAndDispatch` (the only non-guarded path into
        // `onTransformFactDirty` subscribers). `publish`/`bump` are guarded
        // by `inTransformSweep`, and mint/rebuild fire outside the sweep.
        // Iterate, then clear at the end — Set iteration order is insertion
        // order, so this is equivalent to the previous snapshot-then-clear.
        for (const unit of dirty) {
          // Rules sweep at the unit's future-dispatch chain. Reads go
          // through the chain directly; publication is `chain.forkBody(unit,
          // witness)` — under ROOT that resolves to `unit.funcAst.body`
          // without a copy.
          const chain = this.futureDispatchChainFor(unit);
          // Retirement guard: fix #2 already prevents `futureDispatchContext`
          // from pointing to a retired node, but keep this as defense so
          // any future path that writes a retired chain still doesn't
          // re-authorize speculative rewrites against it.
          if (this.isRetired(chain)) continue;
          const fired = r.sweep(unit, chain, this._topology);
          if (fired) {
            this.pendingRebuilds.add(unit);
            anyFired = true;
          }
        }
        dirty.clear();
      }
    } finally {
      this.inTransformSweep = false;
    }
    return anyFired;
  }

  /** Allocate an `AnalysisCtx` bound to `context`. `read`/`tryRead`/`readAll`
   *  delegate to the analysis's canonical read surface at this context — the
   *  transfer-level read path. `write`/`evict` go through the worklist's
   *  dispatch so side-effect writes fan out to subscribers (critical for the
   *  DFA factory's paired-cell `.facts` write from inside `.env`'s transfer).
   *  Cross-context reads still go through the analysis directly when needed. */
  private makeCtx(context: AssumptionChain): AnalysisCtx {
    const topology = this._topology;
    const worklist = this;
    return {
      topology,
      currentContext: context,
      read<K, V>(analysis: Analysis<K, V>, key: K): V {
        return analysis.read(key, context);
      },
      tryRead<K, V>(analysis: Analysis<K, V>, key: K): V | undefined {
        return analysis.tryRead(key, context);
      },
      readAll<K, V>(analysis: Analysis<K, V>): ReadonlyMap<K, V> {
        return analysis.readAll(context);
      },
      write<K, V>(analysis: Analysis<K, V>, key: K, value: V): boolean {
        return worklist.writeAndDispatch(analysis, key, value, context);
      },
      evict<K, V>(analysis: Analysis<K, V>, key: K): void {
        storeEvict(analysis.store, key, context);
      },
    };
  }

  private readonly passCtx: AnalysisCtx = this.makeCtx(ROOT_CONTEXT);

  /** Memoize `AnalysisCtx` per context. Without this, every dequeued item
   *  and every fan-out in `handleFactChange` allocated a fresh `AnalysisCtx`
   *  closure wrapper via `makeCtx` even though the returned surface is
   *  identical for any two calls at the same context. The WeakMap lets the
   *  cached entry get collected once its chain is no longer reachable (e.g.
   *  after `releaseChain`), so entries don't pin pruned contexts. */
  private readonly ctxCache: WeakMap<AssumptionChain, AnalysisCtx> = new WeakMap();

  /** Build an `AnalysisCtx` scoped to `context`. The root context reuses
   *  `passCtx` (hot path); non-root contexts memoize the first-seen wrapper. */
  private ctxFor(context: AssumptionChain): AnalysisCtx {
    if (context === ROOT_CONTEXT) return this.passCtx;
    let ctx = this.ctxCache.get(context);
    if (ctx === undefined) {
      ctx = this.makeCtx(context);
      this.ctxCache.set(context, ctx);
    }
    return ctx;
  }

  /** Publish a change event. Called by `writeAndDispatch` after the store
   *  reports an advancing write. Dispatches to every subscriber registered
   *  against `change.analysis` — analysis reader wake-ups and transform
   *  dirty-additions compiled into the same list — and also to any
   *  `onChange` listeners attached at the worklist level (used by poster /
   *  tracing harnesses).
   *
   *  The `ctx` passed to subscribers carries `change.context` as
   *  `currentContext`, so wake-ups enqueue under the same context the write
   *  originated in — cross-context ripple doesn't happen without an
   *  explicit context-crossing edge. */
  private handleFactChange(change: FactChange<unknown, unknown>): void {
    for (const l of this.changeListeners) l(change);
    const subs = this.factSubs.get(change.analysis as Analysis<any, any>);
    if (subs === undefined) return;
    const ctx = this.ctxFor(change.context);
    for (const sub of subs) sub(ctx, change.key);
  }

  /** Subscribe to every fact-advancing write published through this worklist.
   *  Narrower alternatives exist for specific patterns (analysis/transform
   *  subscriptions); this list is for cross-cutting consumers like poster
   *  tracing. Returns a disposer that removes the listener. */
  onChange(listener: (change: FactChange<unknown, unknown>) => void): () => void {
    this.changeListeners.push(listener);
    return () => {
      const idx = this.changeListeners.indexOf(listener);
      if (idx !== -1) this.changeListeners.splice(idx, 1);
    };
  }

  /** Re-seed Kildall for every context-sensitive block analysis at `unit`'s
   *  entry block under `context`. Today that means every registered
   *  narrowing's block analysis plus `purityBlockAnalysis`: purity is not a
   *  narrowing dimension of its own, but witness discovery and memoization do
   *  need its per-context verdicts to exist at intermediate ancestor
   *  contexts. */
  private enqueueNarrowingEntry(unit: Unit, context: AssumptionChain): void {
    for (const n of this.narrowings) {
      const bfa = n.blockAnalysis();
      // `.env` is the fixpoint driver; enqueuing the seed block on it
      // re-runs Kildall and produces paired `.facts` writes as a side effect.
      this.enqueue(bfa.env, bfa.seed(unit), context);
    }
    this.enqueue(purityBlockAnalysis.env, purityBlockAnalysis.seed(unit), context);
  }

  private handleObservationForSpec(
    source: ObservationChannel<any, RawKind>,
    key: any,
    observed: RawKind,
    context: AssumptionChain,
  ): AssumptionChain {
    const applicable = this.narrowingsBySource.get(source);
    if (applicable === undefined || applicable.length === 0) return context;

    // Per-source resolver is validated at construction — all narrowings on
    // this source agree on the resolver that ran here.
    const resolveUnit = this.unitResolverBySource.get(source) ?? unitOfNodeId;
    const unit = resolveUnit(this.passCtx, key);
    if (unit === undefined) return context;

    const parentCtx = context;

    if (observed.kind === "unknown") {
      let pruned = parentCtx;
      for (const n of applicable) {
        const c = carrierOf(pruned, n, key);
        if (c !== undefined) this.retireChain(unit, c);
        pruned = without(pruned, n, key);
      }
      if (pruned === parentCtx) return parentCtx;
      if (this.retirement.isRetired(pruned)) {
        this.futureDispatchContext.delete(unit);
        return ROOT_CONTEXT;
      }
      if (pruned === ROOT_CONTEXT) this.futureDispatchContext.delete(unit);
      else this.futureDispatchContext.set(unit, pruned);
      this.enqueueNarrowingEntry(unit, pruned);
      this.fireSpecRev(unit);
      return pruned;
    }

    let newCtx = parentCtx;
    for (const n of applicable) {
      const lifted = n.lift(observed);
      if (lifted === undefined) continue;
      const c = carrierOf(newCtx, n, key);
      const existing = c?.assumption?.value as unknown;
      if (c !== undefined && n.eq(existing, lifted)) continue;
      if (c !== undefined) {
        // Assumption violated by a conflicting concrete observation.
        // Retire the chain node whose tip carries the stale (n, key)
        // assumption before we splice it out.
        this.retireChain(unit, c);
      }
      const cleaned = c !== undefined ? without(newCtx, n, key) : newCtx;
      newCtx = extend(cleaned, n, key, lifted);
    }

    if (newCtx === parentCtx) return parentCtx;
    if (this.retirement.isRetired(newCtx)) {
      this.futureDispatchContext.delete(unit);
      return ROOT_CONTEXT;
    }
    this.futureDispatchContext.set(unit, newCtx);
    this.enqueueNarrowingEntry(unit, newCtx);
    this.fireSpecRev(unit);
    return newCtx;
  }

  /** Preferred future-dispatch chain for `unit`. Readers choosing which
   *  specialized facts/body to use for the NEXT compile/dispatch should pass
   *  this context to the analysis's read surface. This is not active-frame
   *  runtime provenance. */
  futureDispatchChainFor(unit: Unit): AssumptionChain {
    return this.futureDispatchContext.get(unit) ?? ROOT_CONTEXT;
  }

  /** Same as `futureDispatchChainFor`, keyed by nodeId. Convenience for
   *  consumers that only have an AST node id (e.g. the DfaQuery projection). */
  futureDispatchChainForNode(nodeId: NodeId): AssumptionChain {
    const unit = this._topology.unitOfNode(nodeId);
    return unit === undefined ? ROOT_CONTEXT : this.futureDispatchChainFor(unit);
  }

  /** Rebuild CFG for every pending unit, then fire `onUnitRebuilt`. */
  private flushPendingRebuilds(): Unit[] {
    if (this.pendingRebuilds.size === 0) return [];
    const rebuilt: Unit[] = [];
    for (const unit of this.pendingRebuilds) {
      unit.generation++;
      wireCFG(unit);
      this._topology.reindexUnit(unit);
      rebuilt.push(unit);
    }
    this.pendingRebuilds.clear();
    for (const unit of rebuilt) this.fireRebuild(unit);
    return rebuilt;
  }

  /** Drain to fixed point. Each iteration:
   *   1. `processAnalysesToFixpoint` — analyses / observations converge.
   *   2. `sweepTransforms` — imperative AST rewrites on dirty units.
   *   3. `processAnalysesToFixpoint` — pick up any writes made by transforms (rare, but
   *      transforms may read analysis state that needs to be settled
   *      before rebuild for the next iteration's analyses).
   *   4. `flushPendingRebuilds` — rewire CFGs for units that fired; fires
   *      `onUnitRebuilt`, which re-enqueues analyses and re-marks transforms
   *      dirty.
   *  Terminates when no transform fired and no rebuild occurred.
   *
   *  This is the explicit heavy-weight publication barrier: it runs queued
   *  analyses to quiescence, sweeps transforms, and rebuilds any mutated CFGs.
   *  Online observation ingress happens in `observe()` via `processAnalysesToFixpoint()`;
   *  callers invoke `drain()` when they need transform/rebuild publication.
   *
   *  ## Contract
   *
   *  **Idempotency.** A second `drain()` call with no intervening observations
   *  or transform-dirty marks is a no-op that returns an empty set — step 1
   *  finds nothing queued, step 2 returns false, no rebuilds are pending.
   *  Callers can safely re-drain after reading state; cost is a single fixpoint
   *  check.
   *
   *  **Reentrancy guard.** `publish` and `bump` throw if invoked while step 2
   *  (`sweepTransforms`) is executing. Transforms may read analysis state
   *  freely, but must not enqueue new facts mid-sweep — a transform that needs
   *  to publish should schedule the publication through a rebuild or defer it
   *  to the next drain. See `ctxGuardSweep` for the mechanism.
   *
   *  **Return value.** The set of `FileInput | FunctionDef` AST nodes whose
   *  CFGs were rewired during this drain (via `flushPendingRebuilds`). Empty
   *  when the drain reached fixpoint without triggering any transform that
   *  mutated the AST. Useful for cache invalidation in downstream compilers
   *  that key on AST identity.
   *
   *  **Observation channels.** Drain does not directly trigger the three
   *  observation channels (`observeScopeCall`, `observeParamEntry`,
   *  `observeScopeReturn`) — those fire from the evaluator. What drain does
   *  guarantee is that any observations posted between drains (via `observe`)
   *  have been absorbed into analysis state by the time it returns, so
   *  downstream reads are consistent.
   *
   *  **Non-termination.** Throws if `limit` CFG rebuilds occur without
   *  converging; this indicates a transform cascade that does not stabilise
   *  (typically a pair of transforms that re-dirty each other). */
  drain(limit: number = Worklist.DEFAULT_DRAIN_LIMIT): ReadonlySet<StmtNS.FileInput | StmtNS.FunctionDef> {
    const changed = new Set<StmtNS.FileInput | StmtNS.FunctionDef>();
    let processed = 0;

    while (true) {
      this.processAnalysesToFixpoint();
      const fired = this.sweepTransforms();
      this.processAnalysesToFixpoint();
      const rebuilt = this.flushPendingRebuilds();

      if (!fired && rebuilt.length === 0) break;

      for (const unit of rebuilt) {
        changed.add(unit.funcAst);
        processed++;
      }

      if (processed >= limit) {
        throw new Error(
          `[Worklist] drain exceeded ${limit} CFG rebuilds — likely a non-terminating transform cascade. ` +
          `Raise the limit explicitly via drain(n) only if you've verified convergence.`,
        );
      }
    }

    return changed;
  }

  static readonly DEFAULT_DRAIN_LIMIT = 1000;
}
