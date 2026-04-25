// Driver for analysis-graph dispatch. Single class — the registration
// façade, the fan-out maps, the transform sweep, the speculation-context
// machinery, and the fixpoint driver share enough state through narrow
// channels (`enqueue`, `futureDispatchChainFor`, `isRefuted`, the AnalysisCtx
// cache) that splitting them creates more accidental coupling than it
// removes.

import { StmtNS } from "../../ast-types";
import type { FunctionEnvironments } from "../../resolver";
import {
  carrier as carrierOf,
  extend,
  Refutations,
  ROOT_CONTEXT,
  without,
  type AssumptionChain,
} from "../assumption";
import type { CounterStore } from "../observation/counter-store";
import type { ObservationBinding } from "../observation/observation-binding";
import type { ObservationChannel } from "../observation/observation-channel";
import type { FunctionId, NodeId } from "./analysis";
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
} from "./analysis-store";
import type { BlockFixpointAnalysis } from "./dfa-factory";
import {
  buildOneUnit,
  buildUnits,
  wireCFG,
  type Unit,
} from "./function-unit";
import { isRoot } from "../assumption/chain";
import { ProgramTopology } from "./topology";
/** A `(analysis, key, context)` triple as the worklist enqueues it. */
interface AnalysisTriple {
  analysis: Analysis<any, any>;
  key: unknown;
  context: AssumptionChain;
}

/** FIFO over analysis triples. Backing array is reset to length 0 once
 *  drained so long-lived queues don't pin arbitrary growth; dequeued
 *  entries are nulled so they don't pin GC roots. */
class TripleQueue {
  private readonly items: (AnalysisTriple | undefined)[] = [];
  private head = 0;

  size(): number { return this.items.length - this.head; }

  push(analysis: Analysis<any, any>, key: unknown, context: AssumptionChain): void {
    this.items.push({ analysis, key, context });
  }

  pop(out: AnalysisTriple): boolean {
    if (this.head >= this.items.length) return false;
    const item = this.items[this.head]!;
    out.analysis = item.analysis;
    out.key = item.key;
    out.context = item.context;
    this.items[this.head] = undefined;
    this.head++;
    if (this.head >= this.items.length) {
      this.items.length = 0;
      this.head = 0;
    }
    return true;
  }
}

/** Construction payload for `Worklist`. Keeping this an object avoids the
 *  positional-argument cliff for a constructor with this many conceptually
 *  independent wiring inputs. */
export interface WorklistConfig {
  readonly ast: StmtNS.FileInput;
  readonly functionEnvironments: FunctionEnvironments;
  readonly analyses: ReadonlyArray<Analysis<any, any>>;
  readonly transforms: ReadonlyArray<TransformRule>;
  readonly narrowings?: ReadonlyArray<Narrowing<any, any>>;
  readonly counters?: ReadonlyArray<CounterStore<any>>;
  readonly channels?: ReadonlyArray<ObservationChannel<any, any>>;
  /** Context-sensitive block analyses re-seeded at every narrowing-entry
   *  alongside each narrowing's own `blockAnalysis()`. Carries verdicts
   *  (e.g. purity) that must track each specialization context but whose
   *  analyses aren't themselves narrowings. Policy-owned by the caller. */
  readonly extraEntryBlockAnalyses?: ReadonlyArray<BlockFixpointAnalysis<any>>;
  readonly observationBindings?: ReadonlyArray<ObservationBinding<any, any>>;
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
  private readonly dequeued: AnalysisTriple = {
    analysis: undefined as unknown as Analysis<any, any>,
    key: undefined,
    context: undefined as unknown as AssumptionChain,
  };
  /** Dedup guard: `(analysis, context, key)` enqueued twice before drain is
   *  a single item. Sibling contexts run independent Kildall. */
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

  /** Reentrancy guard: set while `sweepTransforms` runs. `publish`/`bump`
   *  throw when true — observation ingress mid-sweep would shift
   *  `futureDispatchChainFor(unit)` under the sweep's feet. */
  private inTransformSweep = false;

  /** Per-unit preferred chain for future compiles/dispatches. Unset or
   *  ROOT_CONTEXT means future dispatch is unspecialized for that unit. */
  private readonly futureDispatchContext: Map<Unit, AssumptionChain> = new Map();

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
  /** Lifecycle dispatch indices, one array per event kind. */
  private readonly mintSubs: Array<(ctx: AnalysisCtx, unit: Unit) => void> = [];
  private readonly rebuildSubs: Array<(ctx: AnalysisCtx, unit: Unit) => void> = [];
  private readonly specRevSubs: Array<(ctx: AnalysisCtx, unit: Unit) => void> = [];

  /** Refutation filter (minimal generators; `contains(c) = ∃ r. leq(r, c)`). */
  private readonly refutations: Refutations = new Refutations();
  /** Subscribers fired after a (unit, carrier) is refuted. Used by layers
   *  (e.g. memoization) that maintain their own chain-keyed caches and need
   *  to invalidate them — keeps the framework free of concrete cache knowledge. */
  private readonly refuteSubs: Array<(unit: Unit, carrier: AssumptionChain) => void> = [];

  private readonly functionEnvironments: FunctionEnvironments;

  get topology(): ProgramTopology {
    return this._topology;
  }

  get units(): ReadonlyMap<FunctionId, Unit> {
    return this._topology.units;
  }

  unitOfNode(nodeId: NodeId): Unit | undefined {
    return this._topology.unitOfNode(nodeId);
  }

  private readonly narrowings: ReadonlyArray<Narrowing<any, any>>;
  /** Context-sensitive block analyses re-seeded at every narrowing-entry
   *  alongside each narrowing's own `blockAnalysis()`. Carries verdicts
   *  (e.g. purity) that must track each specialization context but whose
   *  analyses aren't themselves narrowings. Policy-owned by the caller. */
  private readonly extraEntryBlockAnalyses: ReadonlyArray<BlockFixpointAnalysis<any>>;
  /** Per-source unit resolver; all bindings on a source must agree. */
  private readonly unitResolverBySource: Map<
    ObservationChannel<any, any>,
    UnitResolver<any>
  >;
  /** Per-source observation bindings, indexed for ingress dispatch. */
  private readonly bindingsBySource: ReadonlyMap<
    ObservationChannel<any, any>,
    ReadonlyArray<ObservationBinding<any, any>>
  >;

  private readonly registeredChannels = new Set<ObservationChannel<any, any>>();

  constructor(config: WorklistConfig) {
    const {
      ast,
      functionEnvironments,
      analyses,
      transforms,
      narrowings = [],
      counters = [],
      channels = [],
      extraEntryBlockAnalyses = [],
      observationBindings = [],
    } = config;
    this.narrowings = narrowings;
    this.extraEntryBlockAnalyses = extraEntryBlockAnalyses;
    // Group bindings by `source`. Each group must agree on `resolveUnit`
    // so registration bugs surface at construction.
    const unitResolverBySource = new Map<ObservationChannel<any, any>, UnitResolver<any>>();
    const bindingsBySource = new Map<ObservationChannel<any, any>, ObservationBinding<any, any>[]>();
    for (const b of observationBindings) {
      const source = b.source;
      const resolver: UnitResolver<any> = b.resolveUnit ?? unitOfNodeId;
      const existing = unitResolverBySource.get(source);
      if (existing === undefined) {
        unitResolverBySource.set(source, resolver);
      } else if (existing !== resolver) {
        throw new Error(
          `[Worklist] bindings sharing a source disagree on resolveUnit — all bindings on one source must resolve to the same unit.`,
        );
      }
      const group = bindingsBySource.get(source);
      if (group === undefined) bindingsBySource.set(source, [b]);
      else group.push(b);
    }
    this.unitResolverBySource = unitResolverBySource;
    this.bindingsBySource = bindingsBySource;
    this.functionEnvironments = functionEnvironments;
    for (const [, unit] of buildUnits(ast, functionEnvironments)) {
      this._topology.registerUnit(unit);
    }

    for (const p of analyses) this.register(p);
    for (const c of counters) this.registerCounter(c);
    for (const ch of channels) this.registerChannel(ch);
    for (const r of transforms) this.registerTransform(r);
  }

  /** Register a structurally-introduced FunctionDef: build its Unit, publish
   *  to the topology, and fire `onMint` subscribers. ROOT-only — function
   *  identity has no chain dimension, so a non-ROOT rewrite would publish a
   *  function visible to every sibling chain. */
  addFunction(node: StmtNS.FunctionDef, chain: AssumptionChain): Unit {
    if (!isRoot(chain)) {
      throw new Error(
        `[Worklist] addFunction: structural rewrites are ROOT-only (chain depth=${chain.depth}).`,
      );
    }
    const unit = buildOneUnit(node, this.functionEnvironments);
    this._topology.registerUnit(unit);
    for (const sub of this.mintSubs) sub(this.passCtx, unit);
    return unit;
  }

  private dirtyFor(rule: TransformRule): Set<Unit> {
    const s = this.transformDirty.get(rule);
    if (s === undefined) {
      throw new Error(`[Worklist] transform has no dirty set — missed registerTransform?`);
    }
    return s;
  }

  /** `c` is refuted iff any generator is an algebraic subset. */
  isRefuted(node: AssumptionChain): boolean {
    return this.refutations.contains(node);
  }

  /** Subscribe to refutation events. Fires after the refutation is
   *  recorded, before the future-dispatch context is reconciled. Used by
   *  layers (memoization, etc.) that hold chain-keyed state. */
  onRefute(callback: (unit: Unit, carrier: AssumptionChain) => void): void {
    this.refuteSubs.push(callback);
  }

  /** Refute `carrier` for `unit`: add the minimal singleton of the carrier's
   *  tip binding, fire `onRefute` subscribers (so external chain-keyed
   *  caches can invalidate), and drop `futureDispatchContext[unit]` if it
   *  points into the refuted subtree. Body eviction is lazy. Idempotent. */
  private refute(unit: Unit, carrier: AssumptionChain): void {
    if (carrier === ROOT_CONTEXT) return;
    // MINIMAL generators: storing the full carrier chain would under-refute
    // — sibling chains carrying the same refuted binding under a different
    // prefix would escape `isRefuted`.
    const a = carrier.assumption!;
    const minimal = extend(ROOT_CONTEXT, a.narrowing, a.key, a.value);
    this.refutations.add(minimal);
    for (const sub of this.refuteSubs) sub(unit, carrier);
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
    opts?: { enqueueAt?: (sourceCtx: AssumptionChain) => AssumptionChain },
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
    if ("polarity" in (rule as object)) {
      throw new Error(
        "[Worklist.registerTransform] rule carries `polarity` — polarity is an Analysis-only field. " +
        "If this rule really is an Analysis, register it via `register`; otherwise drop the field.",
      );
    }
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
    if ("polarity" in (counter as object)) {
      throw new Error(
        "[Worklist.registerCounter] counter carries `polarity` — polarity is an Analysis-only field. " +
        "Counters are monotonic, not fixpoint-iterated; they have no merge polarity.",
      );
    }
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

  /** Subscribe a transform to counter bumps. */
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
  tryRead<K, V>(analysis: Analysis<K, V>, key: K, context: AssumptionChain): V | undefined {
    return analysis.store.tryRead(key, context);
  }

  /** Record a runtime observation made under `context`. Extends or prunes
   *  the owning unit's speculation context via every narrowing bound on
   *  `channel`, then drives analyses to fixpoint.
   *
   *  Returns the caller's next frame-local provenance chain (extended or
   *  pruned). */
  publish<K, V>(
    channel: ObservationChannel<K, V>,
    key: K,
    value: V,
    context: AssumptionChain,
  ): AssumptionChain {
    if (this.inTransformSweep) {
      throw new Error(
        `[Worklist.publish] called during transform sweep. ` +
        `Observations extend futureDispatchChainFor(unit); allowing them mid-sweep ` +
        `means rules generate code against a chain that has already widened.`,
      );
    }
    const nextContext = this.handleObservationForSpec(channel, key, value, context);
    this.processAnalysesToFixpoint();
    return nextContext;
  }

  /** Register a channel. Idempotent. */
  registerChannel<K, V>(channel: ObservationChannel<K, V>): void {
    if ("polarity" in (channel as object)) {
      throw new Error(
        "[Worklist.registerChannel] channel carries `polarity` — polarity is an Analysis-only field. " +
        "Channels are observation sinks, not facts; they have no merge polarity.",
      );
    }
    const c = channel as ObservationChannel<any, any>;
    if (this.registeredChannels.has(c)) return;
    this.registeredChannels.add(c);
    channel.bind?.(this);
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

  /** Scratch set for the currently-transferring (analysis, key) so `ctx.read`
   *  can record the edge `(sourceAnalysis, sourceKey) → reader` without
   *  threading the reader through the AnalysisCtx surface. Context is
   *  intentionally NOT recorded: the reader is re-enqueued at the WRITE
   *  context (matching `onFactDirty`'s default), which is what propagates
   *  fact changes across speculation contexts. `undefined` outside transfer. */
  private currentReader: { analysis: Analysis<any, any>; key: unknown } | undefined;

  /** Read-tracking edges: `(source, sourceKey) → list of (reader, readerKey)`.
   *  Populated as a side effect of `ctx.read`/`ctx.tryRead`/`ctx.readDeepest`/
   *  `ctx.readMinimal` during transfer; consulted by `writeAndDispatch` after
   *  an advancing write to enqueue readers at the WRITE context. */
  private readonly readEdges = new Map<
    Analysis<any, any>,
    Map<unknown, Array<{ readonly analysis: Analysis<any, any>; readonly key: unknown }>>
  >();

  private recordReadEdge(source: Analysis<any, any>, sourceKey: unknown): void {
    const reader = this.currentReader;
    if (reader === undefined) return;
    let byKey = this.readEdges.get(source);
    if (byKey === undefined) {
      byKey = new Map();
      this.readEdges.set(source, byKey);
    }
    let list = byKey.get(sourceKey);
    if (list === undefined) {
      list = [];
      byKey.set(sourceKey, list);
    }
    // Linear dedup: readers per source-key are expected to be few.
    for (const e of list) {
      if (e.analysis === reader.analysis && e.key === reader.key) return;
    }
    list.push(reader);
  }

  /** Drain both queues to empty. Runtime tier preempts analysis tier. */
  private processAnalysesToFixpoint(): void {
    const out = this.dequeued;
    while (this.runtimeQueue.size() > 0 || this.analysisQueue.size() > 0) {
      const q = this.runtimeQueue.size() > 0 ? this.runtimeQueue : this.analysisQueue;
      if (!q.pop(out)) break;
      const { analysis, key, context } = out;
      this.pendingKeysByAnalysis.get(analysis)?.get(context)?.delete(key);
      this.currentReader = { analysis, key };
      let value: unknown;
      try {
        value = analysis.transfer(this.ctxFor(context), key);
      } finally {
        this.currentReader = undefined;
      }
      if (value !== undefined) this.writeAndDispatch(analysis, key, value as any, context);
    }
  }

  /** The single site funneling transfer results into the store and fanning
   *  them out to subscribers. Returns true iff the cell advanced. */
  private writeAndDispatch<K, V>(
    analysis: Analysis<K, V>,
    key: K,
    value: V,
    context: AssumptionChain,
  ): boolean {
    const result = storeWrite(analysis.store, key, value, context);
    if (result === null) return false;
    // Read-tracked readers of (analysis, key) — re-enqueue at the WRITE
    // context, matching `onFactDirty`'s default. This is what propagates
    // fact changes across speculation contexts: a reader originally run at
    // ROOT gets re-enqueued at specCtx when its input advances at specCtx.
    const readers = this.readEdges.get(analysis as Analysis<any, any>)?.get(key);
    if (readers !== undefined) {
      for (const r of readers) this.enqueue(r.analysis, r.key, context);
    }
    const subs = this.factSubs.get(analysis as Analysis<any, any>);
    if (subs === undefined) return true;
    const ctx = this.ctxFor(context);
    for (const sub of subs) sub(ctx, key);
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
  private makeCtx(context: AssumptionChain): AnalysisCtx {
    const topology = this._topology;
    const worklist = this;
    return {
      topology,
      units: topology.units,
      unitOfNode: (nodeId) => topology.unitOfNode(nodeId),
      currentContext: context,
      read<K, V>(analysis: Analysis<K, V>, key: K): V {
        worklist.recordReadEdge(analysis as Analysis<any, any>, key);
        return analysis.store.read(key, context);
      },
      tryRead<K, V>(analysis: Analysis<K, V>, key: K): V | undefined {
        worklist.recordReadEdge(analysis as Analysis<any, any>, key);
        return analysis.store.tryRead(key, context);
      },
      readAll<K, V>(analysis: Analysis<K, V>): ReadonlyMap<K, V> {
        // Whole-store read: cannot record per-key edges without knowing the
        // keyspace. Callers needing fine-grained invalidation should read
        // individual cells. Today no analysis transfer uses readAll; if that
        // changes, pair the readAll with explicit onFactDirty until a
        // "depends on all keys" edge is modeled.
        return analysis.store.readAll(context);
      },
      readMinimal<K, V>(
        analysis: Analysis<K, V>,
        key: K,
        accept: (value: V) => boolean,
      ): { value: V; witness: AssumptionChain } | undefined {
        worklist.recordReadEdge(analysis as Analysis<any, any>, key);
        return analysis.store.readMinimal(context, key, accept);
      },
      readDeepest<K, V>(
        analysis: Analysis<K, V>,
        key: K,
      ): { value: V; witness: AssumptionChain } | undefined {
        worklist.recordReadEdge(analysis as Analysis<any, any>, key);
        return analysis.store.readDeepest(context, key);
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
  private readonly ctxCache: WeakMap<AssumptionChain, AnalysisCtx> = new WeakMap();

  private ctxFor(context: AssumptionChain): AnalysisCtx {
    if (context === ROOT_CONTEXT) return this.passCtx;
    let ctx = this.ctxCache.get(context);
    if (ctx === undefined) {
      ctx = this.makeCtx(context);
      this.ctxCache.set(context, ctx);
    }
    return ctx;
  }

  /** Re-seed Kildall for every context-sensitive block analysis at `unit`'s
   *  entry block under `context`. Covers every registered narrowing plus any
   *  `extraEntryBlockAnalyses` passed in by the caller. */
  private enqueueNarrowingEntry(unit: Unit, context: AssumptionChain): void {
    for (const n of this.narrowings) {
      const bfa = n.blockAnalysis();
      this.enqueue(bfa.env, bfa.seed(unit), context);
    }
    for (const bfa of this.extraEntryBlockAnalyses) {
      this.enqueue(bfa.env, bfa.seed(unit), context);
    }
  }

  private handleObservationForSpec<V>(
    source: ObservationChannel<any, V>,
    key: any,
    observed: V,
    context: AssumptionChain,
  ): AssumptionChain {
    const applicable = this.bindingsBySource.get(source);
    if (applicable === undefined || applicable.length === 0) return context;

    const resolveUnit = this.unitResolverBySource.get(source) ?? unitOfNodeId;
    const unit = resolveUnit(this.passCtx, key);
    if (unit === undefined) return context;

    const parentCtx = context;

    if (source.isUnknown(observed)) {
      let pruned = parentCtx;
      for (const b of applicable) {
        const c = carrierOf(pruned, b.narrowing, key);
        if (c !== undefined) this.refute(unit, c);
        pruned = without(pruned, b.narrowing, key);
      }
      if (pruned === parentCtx) return parentCtx;
      if (this.refutations.contains(pruned)) {
        this.futureDispatchContext.delete(unit);
        return ROOT_CONTEXT;
      }
      if (pruned === ROOT_CONTEXT) this.futureDispatchContext.delete(unit);
      else this.futureDispatchContext.set(unit, pruned);
      this.enqueueNarrowingEntry(unit, pruned);
      for (const sub of this.specRevSubs) sub(this.passCtx, unit);
      return pruned;
    }

    let newCtx = parentCtx;
    for (const b of applicable) {
      const lifted = b.lift(observed);
      if (lifted === undefined) continue;
      const c = carrierOf(newCtx, b.narrowing, key);
      const existing = c?.assumption?.value as unknown;
      if (c !== undefined && b.narrowing.eq(existing, lifted)) continue;
      if (c !== undefined) {
        // Refute the chain node carrying the stale (n, key) binding before
        // splicing it out — a conflicting concrete observation violates it.
        this.refute(unit, c);
      }
      const cleaned = c !== undefined ? without(newCtx, b.narrowing, key) : newCtx;
      newCtx = extend(cleaned, b.narrowing, key, lifted);
    }

    if (newCtx === parentCtx) return parentCtx;
    if (this.refutations.contains(newCtx)) {
      this.futureDispatchContext.delete(unit);
      return ROOT_CONTEXT;
    }
    this.futureDispatchContext.set(unit, newCtx);
    this.enqueueNarrowingEntry(unit, newCtx);
    for (const sub of this.specRevSubs) sub(this.passCtx, unit);
    return newCtx;
  }

  /** Preferred future-dispatch chain for `unit`. Not active-frame provenance. */
  futureDispatchChainFor(unit: Unit): AssumptionChain {
    return this.futureDispatchContext.get(unit) ?? ROOT_CONTEXT;
  }

  /** Same as `futureDispatchChainFor`, keyed by nodeId. */
  futureDispatchChainForNode(nodeId: NodeId): AssumptionChain {
    const unit = this._topology.unitOfNode(nodeId);
    return unit === undefined ? ROOT_CONTEXT : this.futureDispatchChainFor(unit);
  }

  /** Rebuild CFG for every pending unit, then fire the rebuild hooks. */
  private flushPendingRebuilds(): Unit[] {
    if (this.pendingRebuilds.size === 0) return [];
    const rebuilt: Unit[] = [];
    for (const unit of this.pendingRebuilds) {
      wireCFG(unit);
      this._topology.reindexUnit(unit);
      rebuilt.push(unit);
    }
    this.pendingRebuilds.clear();
    for (const unit of rebuilt) {
      for (const sub of this.rebuildSubs) sub(this.passCtx, unit);
    }
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
