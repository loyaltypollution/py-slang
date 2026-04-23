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
  storeEvict,
  storeWrite,
  type FactChange,
} from "./analysis-store";
import {
  ROOT_CONTEXT,
  type Speculation
} from "./assumption-chain";
import { carrier as carrierOf, extend, without } from "./assumption-algebra";
import { Refutations } from "./refutation";
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
import { clearMemoId } from "../../runtime/memo";
import { directParamEntryGuardsFor, guardKeyFromGuards } from "../entry-guards";
// `purityBlockAnalysis` is the one residual framework→specific-analysis
// coupling — its per-context verdicts are re-seeded alongside every
// narrowing's block analysis in `enqueueNarrowingEntry`.
import { purityBlockAnalysis } from "../purity-analysis/analysis";
import { memoIdFor } from "../transforms/memoization";
import type { RawKind } from "./raw-value";

class TripleQueue {
  private readonly analyses: Array<Analysis<any, any>> = [];
  private readonly keys: unknown[] = [];
  private readonly contexts: Speculation[] = [];
  private head = 0;

  size(): number {
    return this.analyses.length - this.head;
  }

  push(analysis: Analysis<any, any>, key: unknown, context: Speculation): void {
    this.analyses.push(analysis);
    this.keys.push(key);
    this.contexts.push(context);
  }

  /** Dequeue the head triple into `out`. Returns true iff an item was dequeued. */
  pop(out: { analysis: Analysis<any, any>; key: unknown; context: Speculation }): boolean {
    if (this.head >= this.analyses.length) return false;
    const i = this.head;
    out.analysis = this.analyses[i];
    out.key = this.keys[i];
    out.context = this.contexts[i];
    // Null out references so dequeued entries don't pin GC roots.
    this.analyses[i] = undefined as unknown as Analysis<any, any>;
    this.keys[i] = undefined;
    this.contexts[i] = undefined as unknown as Speculation;
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

/** Group narrowings by `observationSource`. Asserts each group agrees on
 *  `resolveUnit` so registration bugs surface at construction. */
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
  private readonly _topology = new ProgramTopology();

  /** Units awaiting CFG rebuild after a transform fire. */
  private readonly pendingRebuilds = new Set<Unit>();

  private readonly registeredAnalyses = new Set<Analysis<any, any>>();
  // Two tier-specific FIFOs: the only enforced order is
  // `tier(runtime) < tier(analysis)` with FIFO-within-tier.
  private readonly runtimeQueue = new TripleQueue();
  private readonly analysisQueue = new TripleQueue();
  /** Scratch object reused by `TripleQueue.pop`. */
  private readonly dequeued: { analysis: Analysis<any, any>; key: unknown; context: Speculation } = {
    analysis: undefined as unknown as Analysis<any, any>,
    key: undefined,
    context: undefined as unknown as Speculation,
  };
  /** Dedup guard: `(analysis, context, key)` enqueued twice before drain is
   *  a single item. Sibling contexts run independent Kildall. */
  private readonly pendingKeysByAnalysis = new Map<
    Analysis<any, any>,
    Map<Speculation, Set<unknown>>
  >();

  /** Registered transforms and their dirty sets. A unit enters the dirty set
   *  on mint, rebuild, or a write to an upstream analysis the rule subscribes
   *  to; sweep clears it. */
  private readonly transforms: TransformRule[] = [];
  private readonly transformsSet = new Set<TransformRule>();
  private readonly transformDirty = new Map<TransformRule, Set<Unit>>();

  /** Reentrancy guard: set while `sweepTransforms` runs. `publish`/`bump`
   *  throw when true — observation ingress mid-sweep would shift
   *  `futureDispatchChainFor(unit)` under the sweep's feet. */
  private inTransformSweep = false;

  /** Per-unit preferred chain for future compiles/dispatches. Unset or
   *  ROOT_CONTEXT means future dispatch is unspecialized for that unit. */
  private readonly futureDispatchContext: Map<Unit, Speculation> = new Map();

  /** Fact-change, counter-bump, and channel-publish dispatch indices.
   *  Analyses' and transforms' subscriptions compile into callbacks here. */
  private readonly factSubs = new Map<
    Analysis<any, any>,
    Array<(ctx: AnalysisCtx, key: unknown) => void>
  >();
  private readonly counterSubs = new Map<
    CounterStore<any>,
    Array<(ctx: AnalysisCtx, key: unknown) => void>
  >();
  private readonly registeredCounters = new Set<CounterStore<any>>();
  private readonly channelSubs = new Map<
    ObservationChannel<any, any>,
    Array<(ctx: AnalysisCtx, key: unknown) => void>
  >();
  /** Lifecycle dispatch indices, one array per event kind. */
  private readonly mintSubs: Array<(ctx: AnalysisCtx, unit: Unit) => void> = [];
  private readonly rebuildSubs: Array<(ctx: AnalysisCtx, unit: Unit) => void> = [];
  private readonly specRevSubs: Array<(ctx: AnalysisCtx, unit: Unit) => void> = [];

  /** Refutation filter (minimal generators; `contains(c) = ∃ r. leq(r, c)`). */
  private readonly refutations: Refutations = new Refutations();

  readonly registry: FunctionRegistry;
  private readonly functionEnvironments: FunctionEnvironments;

  get topology(): ProgramTopology {
    return this._topology;
  }

  get units(): ReadonlyMap<FunctionId, Unit> {
    return this._topology.units;
  }

  private readonly narrowings: ReadonlyArray<Narrowing<any, any>>;
  /** Per-source unit resolver; all narrowings on a source must agree. */
  private readonly unitResolverBySource: Map<
    ObservationChannel<any, RawKind>,
    UnitResolver<any>
  >;
  private readonly narrowingsBySource: ReadonlyMap<
    ObservationChannel<any, RawKind>,
    ReadonlyArray<Narrowing<any, any>>
  >;

  private readonly registeredChannels = new Set<ObservationChannel<any, any>>();

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
    for (const [, unit] of buildUnits(ast, functionEnvironments, this.registry)) {
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

    this.registry.setListener({
      onMint: (node, slot) => this.onRegistryMint(node, slot),
    });
  }

  private onRegistryMint(node: FunctionScopeNode, _slot: number): void {
    if (!(node instanceof StmtNS.FunctionDef)) return;
    const unit = buildOneUnit(node, this.functionEnvironments, this.registry);
    this._topology.registerUnit(unit);
    this.fireMint(unit);
  }

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
  private fireSpecRev(unit: Unit): void {
    for (const sub of this.specRevSubs) sub(this.passCtx, unit);
  }

  /** `c` is refuted iff any generator is an algebraic subset. */
  isRefuted(node: Speculation): boolean {
    return this.refutations.contains(node);
  }

  /** Refute `carrier` for `unit`: add the minimal singleton of the carrier's
   *  tip binding, clear the memo bucket keyed to its direct-param entry
   *  guards, and drop `futureDispatchContext[unit]` if it points into the
   *  refuted subtree. Body eviction is lazy. Idempotent. */
  private refute(unit: Unit, carrier: Speculation): void {
    if (carrier === ROOT_CONTEXT) return;
    // MINIMAL generators: storing the full carrier chain would under-refute
    // — sibling chains carrying the same refuted binding under a different
    // prefix would escape `isRefuted`.
    const a = carrier.assumption!;
    const minimal = extend(ROOT_CONTEXT, a.narrowing, a.key, a.value);
    this.refutations.add(minimal);
    const fd = unit.funcAst;
    if (fd instanceof StmtNS.FunctionDef) {
      clearMemoId(memoIdFor(fd, guardKeyFromGuards(directParamEntryGuardsFor(unit, carrier))));
    }
    const fdCtx = this.futureDispatchContext.get(unit);
    if (fdCtx !== undefined && this.refutations.contains(fdCtx)) {
      this.futureDispatchContext.delete(unit);
    }
  }

  private static addSub<S>(
    map: Map<S, Array<(ctx: AnalysisCtx, key: unknown) => void>>,
    source: S,
    fn: (ctx: AnalysisCtx, key: unknown) => void,
  ): void {
    const list = map.get(source);
    if (list === undefined) map.set(source, [fn]);
    else list.push(fn);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Typed `on*` subscribe methods.
  //   factWrite  → onFactDirty
  //   mint       → onMint
  //   rebuild    → onRebuildDirty + onRebuildEvict
  //   specRev    → onSpecRev
  // ─────────────────────────────────────────────────────────────────────────

  /** Subscribe `reader` to dirtied keys when `from` advances at any key.
   *  `dirtied(ctx, key)` projects the upstream key-change into the reader's
   *  key space.
   *
   *  `opts.enqueueAt` projects the source context into the enqueue context;
   *  default is the context the upstream write happened in. Use
   *  `enqueueAt: () => ROOT_CONTEXT` for context-blind readers. */
  onFactDirty<K>(
    from: Analysis<any, any>,
    reader: Analysis<K, any>,
    dirtied: (ctx: AnalysisCtx, key: unknown) => Iterable<K>,
    opts?: { enqueueAt?: (sourceCtx: Speculation) => Speculation },
  ): void {
    const project = opts?.enqueueAt;
    Worklist.addSub(this.factSubs, from, (ctx, key) => {
      const enqueueCtx = project !== undefined ? project(ctx.currentContext) : ctx.currentContext;
      for (const k of dirtied(ctx, key)) this.enqueue(reader, k, enqueueCtx);
    });
  }

  /** Subscribe `reader` to mint of any unit. Fires immediately against every
   *  existing unit at registration so late subscribers pick up the initial
   *  burst. */
  onMint<K>(
    reader: Analysis<K, any>,
    dirtied: (ctx: AnalysisCtx, unit: Unit) => Iterable<K>,
  ): void {
    this.mintSubs.push((_ctx, unit) => {
      for (const k of dirtied(this.passCtx, unit)) this.enqueue(reader, k, ROOT_CONTEXT);
    });
    for (const unit of this._topology.units.values()) {
      for (const k of dirtied(this.passCtx, unit)) this.enqueue(reader, k, ROOT_CONTEXT);
    }
  }

  /** Subscribe `reader` to rebuild of any unit. Distinct from mint because
   *  rebuild-time invalidation often needs a paired `onRebuildEvict`. */
  onRebuildDirty<K>(
    reader: Analysis<K, any>,
    dirtied: (ctx: AnalysisCtx, unit: Unit) => Iterable<K>,
  ): void {
    this.rebuildSubs.push((_ctx, unit) => {
      for (const k of dirtied(this.passCtx, unit)) this.enqueue(reader, k, ROOT_CONTEXT);
    });
  }

  /** Subscribe an evict callback to rebuild. Typically used to drop block-
   *  keyed cells whose `BasicBlock` identities belong to the pre-rebuild CFG. */
  onRebuildEvict(evict: (unit: Unit) => void): void {
    this.rebuildSubs.push((_ctx, unit) => evict(unit));
  }

  /** Subscribe `reader` to spec-context bumps on any unit. Fires when
   *  observation-driven extension mutates `futureDispatchContext`. */
  onSpecRev<K>(
    reader: Analysis<K, any>,
    dirtied: (ctx: AnalysisCtx, unit: Unit) => Iterable<K>,
  ): void {
    this.specRevSubs.push((_ctx, unit) => {
      for (const k of dirtied(this.passCtx, unit)) this.enqueue(reader, k, ROOT_CONTEXT);
    });
  }

  /** Register an analysis. Idempotent. */
  register<K, V>(analysis: Analysis<K, V>): void {
    const a = analysis as Analysis<any, any>;
    if (this.registeredAnalyses.has(a)) return;
    this.registeredAnalyses.add(a);
    analysis.bind?.(this);
  }

  /** Register a transform rule. Idempotent. Auto-installs mint/rebuild
   *  dirtying for the rule's own unit, then lets the rule subscribe via `bind`. */
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

  /** Public mutator for a transform's dirty set. */
  dirtyTransform(rule: TransformRule, unit: Unit): void {
    this.dirtyFor(rule).add(unit);
  }

  /** Mirror of `onFactDirty` for transforms. */
  onTransformFactDirty<K>(
    rule: TransformRule,
    from: Analysis<K, any>,
    dirtied: (ctx: AnalysisCtx, key: K) => Iterable<Unit>,
  ): void {
    const dirty = this.dirtyFor(rule);
    Worklist.addSub(this.factSubs, from as Analysis<any, any>, (ctx, key) => {
      for (const u of dirtied(ctx, key as K)) dirty.add(u);
    });
  }

  /** Register a counter. Idempotent. */
  registerCounter<K>(counter: CounterStore<K>): void {
    const c = counter as CounterStore<any>;
    if (this.registeredCounters.has(c)) return;
    this.registeredCounters.add(c);
    counter.bind?.(this);
  }

  /** Increment `counter[key]` by 1 (clamped at `counter.saturation`). Fires
   *  subscribers on advancing bumps; post-saturation bumps are no-ops. */
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

  /** Subscribe `reader` to bumps on `counter`. Yielded keys enqueue under
   *  ROOT_CONTEXT (counters have no context). */
  onCounterBumped<K, K2>(
    counter: CounterStore<K>,
    reader: Analysis<K2, any>,
    dirtied: (ctx: AnalysisCtx, key: K) => Iterable<K2>,
  ): void {
    Worklist.addSub(this.counterSubs, counter as CounterStore<any>, (ctx, key) => {
      for (const k of dirtied(ctx, key as K)) this.enqueue(reader, k, ROOT_CONTEXT);
    });
  }

  /** Mirror of `onCounterBumped` for transforms. */
  onTransformCounterBumped<K>(
    rule: TransformRule,
    counter: CounterStore<K>,
    dirtied: (ctx: AnalysisCtx, key: K) => Iterable<Unit>,
  ): void {
    const dirty = this.dirtyFor(rule);
    Worklist.addSub(this.counterSubs, counter as CounterStore<any>, (ctx, key) => {
      for (const u of dirtied(ctx, key as K)) dirty.add(u);
    });
  }

  /** Public read surface — thin delegation to the analysis's canonical
   *  read method. `context` is mandatory: the worklist does not guess which
   *  chain position a caller meant. */
  tryRead<K, V>(analysis: Analysis<K, V>, key: K, context: Speculation): V | undefined {
    return analysis.tryRead(key, context);
  }

  /** Record a runtime observation made under `context`. Two side effects:
   *  1. `channel` shadow-writes `value` at `context` (for dedup).
   *  2. `handleObservationForSpec` extends or prunes the owning unit's
   *     speculation context via every narrowing on `channel`.
   *
   *  Returns the caller's next frame-local provenance chain (extended or
   *  pruned). The shadow write lands at the incoming `context` regardless. */
  publish<K>(
    channel: ObservationChannel<K, RawKind>,
    key: K,
    value: RawKind,
    context: Speculation,
  ): Speculation {
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

  /** Register a channel. Idempotent. */
  registerChannel<K, V>(channel: ObservationChannel<K, V>): void {
    const c = channel as ObservationChannel<any, any>;
    if (this.registeredChannels.has(c)) return;
    this.registeredChannels.add(c);
    channel.bind?.(this);
  }

  /** Subscribe `reader` to publishes on `channel`. */
  onChannelPublished<K, K2>(
    channel: ObservationChannel<K, any>,
    reader: Analysis<K2, any>,
    dirtied: (ctx: AnalysisCtx, key: K) => Iterable<K2>,
    opts?: { enqueueAt?: (sourceCtx: Speculation) => Speculation },
  ): void {
    const project = opts?.enqueueAt;
    Worklist.addSub(this.channelSubs, channel as ObservationChannel<any, any>, (ctx, key) => {
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
    Worklist.addSub(this.channelSubs, channel as ObservationChannel<any, any>, (ctx, key) => {
      for (const u of dirtied(ctx, key as K)) dirty.add(u);
    });
  }

  enqueue<K, V>(analysis: Analysis<K, V>, key: K, context: Speculation): void {
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

  /** Drain both queues to empty. Runtime tier preempts analysis tier. */
  private processAnalysesToFixpoint(): void {
    const out = this.dequeued;
    while (this.runtimeQueue.size() > 0 || this.analysisQueue.size() > 0) {
      const q = this.runtimeQueue.size() > 0 ? this.runtimeQueue : this.analysisQueue;
      if (!q.pop(out)) break;
      const { analysis, key, context } = out;
      this.pendingKeysByAnalysis.get(analysis)?.get(context)?.delete(key);
      const value = analysis.transfer(this.ctxFor(context), key);
      if (value !== undefined) this.writeAndDispatch(analysis, key, value, context);
    }
  }

  /** The single site funneling transfer results into the store and fanning
   *  them out to subscribers. Returns true iff the cell advanced. */
  private writeAndDispatch<K, V>(
    analysis: Analysis<K, V>,
    key: K,
    value: V,
    context: Speculation,
  ): boolean {
    const result = storeWrite(analysis.store, key, value, context);
    if (result === null) return false;
    // Skip FactChange allocation when nobody is listening — channels with no
    // reader and counters' paired shadow writes land here millions of times
    // during a hot loop.
    const subs = this.factSubs.get(analysis as Analysis<any, any>);
    if (subs === undefined) return true;
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
   *  rewrote move to `pendingRebuilds`; CFG rebuild is NOT flushed here.
   *
   *  Public so online participants (e.g. `jitAnalysis`) can run counter-/
   *  fact-driven transforms before emitting bytecode. Returns true iff any
   *  rule fired. */
  sweepTransforms(): boolean {
    let anyFired = false;
    this.inTransformSweep = true;
    try {
      for (const r of this.transforms) {
        const dirty = this.dirtyFor(r);
        if (dirty.size === 0) continue;
        // `dirty` cannot grow during iteration: sweep bodies receive no
        // worklist/AnalysisCtx, and `publish`/`bump` are guarded by
        // `inTransformSweep`. Iterate, then clear at the end.
        for (const unit of dirty) {
          const chain = this.futureDispatchChainFor(unit);
          // Refutation guard: defense in case a refuted chain is ever stored.
          if (this.isRefuted(chain)) continue;
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
   *  delegate to the analysis's canonical read surface at this context;
   *  `write`/`evict` go through the worklist so side-effect writes fan out
   *  to subscribers. */
  private makeCtx(context: Speculation): AnalysisCtx {
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

  /** Memoize `AnalysisCtx` per context so every dequeue / fan-out doesn't
   *  allocate a fresh closure wrapper. WeakMap lets entries collect when
   *  the chain is no longer reachable. */
  private readonly ctxCache: WeakMap<Speculation, AnalysisCtx> = new WeakMap();

  private ctxFor(context: Speculation): AnalysisCtx {
    if (context === ROOT_CONTEXT) return this.passCtx;
    let ctx = this.ctxCache.get(context);
    if (ctx === undefined) {
      ctx = this.makeCtx(context);
      this.ctxCache.set(context, ctx);
    }
    return ctx;
  }

  /** Dispatch a change event to every subscriber on `change.analysis`.
   *  Wake-ups run under `change.context`, so cross-context ripple doesn't
   *  happen without an explicit context-crossing edge. */
  private handleFactChange(change: FactChange<unknown, unknown>): void {
    const subs = this.factSubs.get(change.analysis as Analysis<any, any>);
    if (subs === undefined) return;
    const ctx = this.ctxFor(change.context);
    for (const sub of subs) sub(ctx, change.key);
  }

  /** Re-seed Kildall for every context-sensitive block analysis at `unit`'s
   *  entry block under `context`. Covers every registered narrowing plus
   *  `purityBlockAnalysis`. */
  private enqueueNarrowingEntry(unit: Unit, context: Speculation): void {
    for (const n of this.narrowings) {
      const bfa = n.blockAnalysis();
      this.enqueue(bfa.env, bfa.seed(unit), context);
    }
    this.enqueue(purityBlockAnalysis.env, purityBlockAnalysis.seed(unit), context);
  }

  private handleObservationForSpec(
    source: ObservationChannel<any, RawKind>,
    key: any,
    observed: RawKind,
    context: Speculation,
  ): Speculation {
    const applicable = this.narrowingsBySource.get(source);
    if (applicable === undefined || applicable.length === 0) return context;

    const resolveUnit = this.unitResolverBySource.get(source) ?? unitOfNodeId;
    const unit = resolveUnit(this.passCtx, key);
    if (unit === undefined) return context;

    const parentCtx = context;

    if (observed.kind === "unknown") {
      let pruned = parentCtx;
      for (const n of applicable) {
        const c = carrierOf(pruned, n, key);
        if (c !== undefined) this.refute(unit, c);
        pruned = without(pruned, n, key);
      }
      if (pruned === parentCtx) return parentCtx;
      if (this.refutations.contains(pruned)) {
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
        // Refute the chain node carrying the stale (n, key) binding before
        // splicing it out — a conflicting concrete observation violates it.
        this.refute(unit, c);
      }
      const cleaned = c !== undefined ? without(newCtx, n, key) : newCtx;
      newCtx = extend(cleaned, n, key, lifted);
    }

    if (newCtx === parentCtx) return parentCtx;
    if (this.refutations.contains(newCtx)) {
      this.futureDispatchContext.delete(unit);
      return ROOT_CONTEXT;
    }
    this.futureDispatchContext.set(unit, newCtx);
    this.enqueueNarrowingEntry(unit, newCtx);
    this.fireSpecRev(unit);
    return newCtx;
  }

  /** Preferred future-dispatch chain for `unit`. Not active-frame provenance. */
  futureDispatchChainFor(unit: Unit): Speculation {
    return this.futureDispatchContext.get(unit) ?? ROOT_CONTEXT;
  }

  /** Same as `futureDispatchChainFor`, keyed by nodeId. */
  futureDispatchChainForNode(nodeId: NodeId): Speculation {
    const unit = this._topology.unitOfNode(nodeId);
    return unit === undefined ? ROOT_CONTEXT : this.futureDispatchChainFor(unit);
  }

  /** Rebuild CFG for every pending unit, then fire the rebuild hooks. */
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

  /** Drain to fixed point. Each iteration runs analyses to quiescence,
   *  sweeps transforms, runs analyses again for transform-emitted writes,
   *  then rebuilds any mutated CFGs. Terminates when no transform fires
   *  and no rebuild occurs.
   *
   *  **Idempotency.** A redundant call returns an empty set.
   *
   *  **Reentrancy guard.** `publish`/`bump` throw if invoked during the
   *  `sweepTransforms` step.
   *
   *  **Return value.** The `FileInput | FunctionDef` nodes whose CFGs were
   *  rewired during this drain.
   *
   *  **Non-termination.** Throws if `limit` rebuilds occur without
   *  converging. */
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
