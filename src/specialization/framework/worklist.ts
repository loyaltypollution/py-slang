// Driver for analysis-graph dispatch: registration façade, fan-out maps,
// transform sweep, speculation-context machinery, and fixpoint driver.

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
import type { NodeId, NodeSet } from "./analysis";
import { intersects } from "../program/node-set";
import {
  type Analysis,
  type AnalysisCtx,
  type EntrySeed,
  type Narrowing,
  type TransformRule,
} from "./analysis";
import {
  storeEvict,
  storeWrite,
} from "./analysis-store";
import { type Function } from "../program/views/function";
import { FunctionManager } from "../program/views/function-manager";
import type { FunctionLocator } from "../program/views/function-locator";
import { FunctionSweepKind } from "../program/views/function-sweep-kind";
import type { SweepKind } from "./sweep-kind";
import type { View } from "../program/views/view";

/** Resolver supplied per-binding (or the default below): turns the channel's
 *  key into the owning Function so observation ingress can route narrowings
 *  to the right unit. */
type UnitResolver = (locator: FunctionLocator, key: any) => Function | undefined;

/** Default resolver: assumes the binding's key is a NodeId and looks up the
 *  enclosing function. ObservationBindings whose key is not a NodeId must
 *  supply their own `resolveUnit`. */
const defaultUnitResolver: UnitResolver = (locator, key) =>
  locator.functionContainingNode(key as NodeId);

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

/** Construction payload for `Worklist`. */
export interface WorklistConfig {
  readonly ast: StmtNS.FileInput;
  readonly functionEnvironments: FunctionEnvironments;
  readonly analyses: ReadonlyArray<Analysis<any, any>>;
  readonly transforms: ReadonlyArray<TransformRule>;
  readonly narrowings?: ReadonlyArray<Narrowing<any, any>>;
  readonly counters?: ReadonlyArray<CounterStore<any>>;
  readonly channels?: ReadonlyArray<ObservationChannel<any, any>>;
  /** Extra entry-seed pairs re-enqueued at every narrowing-entry alongside
   *  each narrowing's own `blockAnalysis()`. Used for context-sensitive
   *  analyses (e.g. purity) that must track each specialization context
   *  but aren't themselves narrowings. Policy-owned by the caller. */
  readonly extraEntrySeeds?: ReadonlyArray<EntrySeed>;
  readonly observationBindings?: ReadonlyArray<ObservationBinding<any, any>>;
}

export class Worklist {
  /** Function-shape state lives here. Worklist's vocabulary stops at view-
   *  agnostic dispatch; everything Function-specific (indices, lifecycle,
   *  speculation context, CFG rebuild) is the manager's concern. */
  readonly functionManager: FunctionManager;

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

  /** Registered transforms and their per-rule sweep state. A view enters
   *  `entry.dirty` on mint, rebuild, or a write to an upstream analysis the
   *  rule subscribes to; sweep clears it. `entry.kind` drives mint/rebuild
   *  wiring, sweep-time chain selection, and post-fire rebuild scheduling. */
  private readonly transforms: TransformRule<any, any>[] = [];
  private readonly transformsSet = new Set<TransformRule<any, any>>();
  private readonly transformEntries = new Map<
    TransformRule<any, any>,
    { kind: SweepKind<any>; dirty: Set<any> }
  >();
  private readonly functionSweepKind: SweepKind<Function>;

  /** Reentrancy guard: set while `sweepTransforms` runs. `publish`/`bump`
   *  throw when true — observation ingress mid-sweep would shift
   *  `futureDispatchChainFor(unit)` under the sweep's feet. */
  private inTransformSweep = false;

  /** Node-intersection-routed subscribers. Each entry declares an `interest`
   *  as a `NodeSet` (typically a view: a block, a function, or an interned
   *  singleton over a sentinel node id). The entry fires when an advancing
   *  write to the source publishes a `delta` such that
   *  `intersects(delta, interest)`. When the producer doesn't pass an explicit
   *  delta to `ctx.write`, `writeAndDispatch` defaults `delta = key` — every
   *  key extends `NodeSet` and self-describes the change. */
  private readonly nodeSetSubs = new Map<
    Analysis<any, any>,
    Array<{
      readonly interest: NodeSet;
      readonly fire: (ctx: AnalysisCtx, key: unknown) => void;
    }>
  >();
  /** Cell-identity subscribers. These fire on every advancing write to the
   *  source cell regardless of node membership; use for CFG self-wake and
   *  transform dirtying, not for node-local dependencies. */
  private readonly advanceSubs = new Map<
    Analysis<any, any>,
    Array<(ctx: AnalysisCtx, key: unknown) => void>
  >();
  private readonly counterSubs = new Map<
    CounterStore<any>,
    Array<(ctx: AnalysisCtx, key: unknown) => void>
  >();
  private readonly registeredCounters = new Set<CounterStore<any>>();

  /** Refutation filter (minimal generators; `contains(c) = ∃ r. leq(r, c)`). */
  private readonly refutations: Refutations = new Refutations();

  /** Read surface for the `Function` view kind — function/block lookups by
   *  id, AST node, or enclosing node. Generic dispatch does not need this;
   *  consumers that genuinely require program shape capture it explicitly
   *  (typically at `Analysis.bind` / `TransformRule.bind`). */
  get locate(): FunctionLocator {
    return this.functionManager;
  }

  private readonly narrowings: ReadonlyArray<Narrowing<any, any>>;
  private readonly extraEntrySeeds: ReadonlyArray<EntrySeed>;
  /** Per-source unit resolver; all bindings on a source must agree. */
  private readonly unitResolverBySource: Map<
    ObservationChannel<any, any>,
    UnitResolver
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
      extraEntrySeeds = [],
      observationBindings = [],
    } = config;
    this.narrowings = narrowings;
    this.extraEntrySeeds = extraEntrySeeds;
    // Group bindings by `source`. Each group must agree on `resolveUnit`
    // so registration bugs surface at construction.
    const unitResolverBySource = new Map<ObservationChannel<any, any>, UnitResolver>();
    const bindingsBySource = new Map<ObservationChannel<any, any>, ObservationBinding<any, any>[]>();
    for (const b of observationBindings) {
      const source = b.source;
      const resolver: UnitResolver = b.resolveUnit ?? defaultUnitResolver;
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
    // Build the function manager FIRST: registrations below depend on
    // the initial mint burst it fires when subscribers register via
    // `onMint`. Manager constructor builds Functions from `ast`.
    this.functionManager = new FunctionManager(ast, functionEnvironments);
    this.functionSweepKind = new FunctionSweepKind(this.functionManager);

    for (const p of analyses) this.register(p);
    for (const c of counters) this.registerCounter(c);
    for (const ch of channels) this.registerChannel(ch);
    for (const r of transforms) this.registerTransform(r);
  }

  private entryFor<V extends View>(
    rule: TransformRule<V, any>,
  ): { kind: SweepKind<V>; dirty: Set<V> } {
    const e = this.transformEntries.get(rule);
    if (e === undefined) throw new Error(`[Worklist] missed registerTransform`);
    return e;
  }

  /** `c` is refuted iff any generator is an algebraic subset. */
  isRefuted(node: AssumptionChain): boolean {
    return this.refutations.contains(node);
  }

  /** Subscribe to refutation events. Delegates to the function manager. */
  onRefute(callback: (unit: Function, carrier: AssumptionChain) => void): void {
    this.functionManager.dispatch.onRefute(callback);
  }

  /** Refute `carrier` for `unit`: add the minimal singleton of the carrier's
   *  tip binding (full chain would under-refute — siblings carrying the same
   *  binding under a different prefix would escape `isRefuted`), then fire
   *  refute subscribers and reconcile dispatch context. Idempotent. */
  private refute(unit: Function, carrier: AssumptionChain): void {
    if (carrier === ROOT_CONTEXT) return;
    const a = carrier.assumption!;
    const minimal = extend(ROOT_CONTEXT, a.narrowing, a.key, a.value);
    this.refutations.add(minimal);
    this.functionManager.dispatch.fireRefuteAndReconcile(unit, carrier, this.refutations);
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

  /** Subscribe `reader` to advancing writes on `from` whose published node
   *  delta intersects `interest` (typically a view, or
   *  `internSingletonNode(id)`). `dirtied` projects the source key-change
   *  into reader keys. `opts.enqueueAt` projects the source context into
   *  the enqueue context (default: the source write context).
   *
   *  HAZARD: synthetic CFG blocks (entry/exit/joins) have empty `nodeIds`,
   *  yielding vacuously-false intersections. Use `subscribeOnAdvance` for
   *  cell-identity wakes on those. */
  subscribe<K extends NodeSet>(
    from: Analysis<any, any>,
    reader: Analysis<K, any>,
    interest: NodeSet,
    dirtied: (locator: FunctionLocator, key: unknown) => Iterable<K>,
    opts?: { enqueueAt?: (sourceCtx: AssumptionChain) => AssumptionChain },
  ): void {
    const project = opts?.enqueueAt;
    const fire = (ctx: AnalysisCtx, key: unknown): void => {
      const enqueueCtx = project !== undefined ? project(ctx.currentContext) : ctx.currentContext;
      for (const k of dirtied(this.functionManager, key)) this.enqueue(reader, k, enqueueCtx);
    };
    let list = this.nodeSetSubs.get(from);
    if (list === undefined) {
      list = [];
      this.nodeSetSubs.set(from, list);
    }
    list.push({ interest, fire });
  }

  /** Subscribe `reader` to every advancing write on `from`, regardless of
   *  node delta. Cell-identity dependency, not node-membership. */
  subscribeOnAdvance<K extends NodeSet>(
    from: Analysis<any, any>,
    reader: Analysis<K, any>,
    dirtied: (locator: FunctionLocator, key: unknown) => Iterable<K>,
    opts?: { enqueueAt?: (sourceCtx: AssumptionChain) => AssumptionChain },
  ): void {
    const project = opts?.enqueueAt;
    Worklist.addSub(this.advanceSubs, from, (ctx, key) => {
      const enqueueCtx = project !== undefined ? project(ctx.currentContext) : ctx.currentContext;
      for (const k of dirtied(this.functionManager, key)) this.enqueue(reader, k, enqueueCtx);
    });
  }

  /** Subscribe `reader` to mint of any unit. Fires against existing units
   *  at registration so late subscribers see the initial burst. */
  onMint<K extends NodeSet>(
    reader: Analysis<K, any>,
    dirtied: (locator: FunctionLocator, unit: Function) => Iterable<K>,
  ): void {
    this.functionManager.onMint(unit => {
      for (const k of dirtied(this.functionManager, unit)) this.enqueue(reader, k, ROOT_CONTEXT);
    });
  }

  /** Subscribe `reader` to rebuild of any unit. Often paired with
   *  `onRebuildEvict` to drop stale block-keyed cells. */
  onRebuildDirty<K extends NodeSet>(
    reader: Analysis<K, any>,
    dirtied: (locator: FunctionLocator, unit: Function) => Iterable<K>,
  ): void {
    this.functionManager.onRebuild(unit => {
      for (const k of dirtied(this.functionManager, unit)) this.enqueue(reader, k, ROOT_CONTEXT);
    });
  }

  /** Subscribe an evict callback to rebuild. Drops block-keyed cells whose
   *  `BasicBlock` identities belong to the pre-rebuild CFG. */
  onRebuildEvict(evict: (unit: Function) => void): void {
    this.functionManager.onRebuild(evict);
  }

  /** Subscribe `reader` to spec-context bumps on any unit. Fires when
   *  observation-driven extension mutates `futureDispatchContext`. */
  onSpecRev<K extends NodeSet>(
    reader: Analysis<K, any>,
    dirtied: (locator: FunctionLocator, unit: Function) => Iterable<K>,
  ): void {
    this.functionManager.dispatch.onSpecRev(unit => {
      for (const k of dirtied(this.functionManager, unit)) this.enqueue(reader, k, ROOT_CONTEXT);
    });
  }

  /** Register an analysis. Idempotent. */
  private register<K extends NodeSet, V>(analysis: Analysis<K, V>): void {
    const a = analysis as Analysis<any, any>;
    if (this.registeredAnalyses.has(a)) return;
    this.registeredAnalyses.add(a);
    analysis.bind?.(this);
  }

  /** Register a transform rule under a sweep kind. Idempotent. Auto-installs
   *  mint/rebuild dirtying through `kind`, then lets the rule subscribe via
   *  `bind`. Function-rooted transforms may omit `kind`. */
  registerTransform(rule: TransformRule<Function, any>): void;
  registerTransform<V extends View>(rule: TransformRule<V, any>, kind: SweepKind<V>): void;
  registerTransform<V extends View>(
    rule: TransformRule<V, any>,
    kind: SweepKind<V> = this.functionSweepKind as unknown as SweepKind<V>,
  ): void {
    if (this.transformsSet.has(rule)) return;
    this.transformsSet.add(rule);
    this.transforms.push(rule);
    const dirty = new Set<V>();
    this.transformEntries.set(rule, { kind, dirty });

    const addUnit = (view: V): void => { dirty.add(view); };
    kind.onMint(addUnit);
    kind.onRebuild(addUnit);
    rule.bind?.(this);
  }

  /** Transform-side fact-dirty: when `from` advances, add the projected
   *  views to `rule`'s dirty set. This is a cell-identity dependency: most
   *  transforms decide their own affected views from the source key rather
   *  than from the producer's node delta. `V` is inferred from `rule`. */
  onTransformFactDirty<V extends View, K extends NodeSet>(
    rule: TransformRule<V, any>,
    from: Analysis<K, any>,
    dirtied: (locator: FunctionLocator, key: K) => Iterable<V>,
  ): void {
    const { dirty } = this.entryFor(rule);
    Worklist.addSub(this.advanceSubs, from as Analysis<any, any>, (_ctx, key) => {
      for (const v of dirtied(this.functionManager, key as K)) dirty.add(v);
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
      throw new Error(`[Worklist.bump] mid-sweep observation ingress is forbidden`);
    }
    const r = counter._applyBump(key);
    if (r === null) return;
    const subs = this.counterSubs.get(counter as CounterStore<any>);
    if (subs !== undefined) {
      for (const s of subs) s(this.passCtx, key);
    }
    this.processAnalysesToFixpoint();
  }

  /** Subscribe a transform to counter bumps. `V` is inferred from `rule`. */
  onTransformCounterBumped<V extends View, K>(
    rule: TransformRule<V, any>,
    counter: CounterStore<K>,
    dirtied: (locator: FunctionLocator, key: K) => Iterable<V>,
  ): void {
    const { dirty } = this.entryFor(rule);
    Worklist.addSub(this.counterSubs, counter as CounterStore<any>, (_ctx, key) => {
      for (const v of dirtied(this.functionManager, key as K)) dirty.add(v);
    });
  }

  /** Public read surface — delegates to `analysis.store.tryRead`. */
  tryRead<K extends NodeSet, V>(analysis: Analysis<K, V>, key: K, context: AssumptionChain): V | undefined {
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
      throw new Error(`[Worklist.publish] mid-sweep observation ingress is forbidden`);
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

  enqueue<K extends NodeSet, V>(analysis: Analysis<K, V>, key: K, context: AssumptionChain): void {
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

  /** The currently-transferring (analysis, key); lets `ctx.read*` record
   *  read-edges without threading the reader through `AnalysisCtx`. Context
   *  is NOT recorded: readers re-enqueue at the WRITE context, which is
   *  what propagates facts across speculation contexts. */
  private currentReader: { analysis: Analysis<any, any>; key: unknown } | undefined;

  /** `(source, sourceKey) → readers`. Populated by `ctx.read*` during
   *  transfer; consulted by `writeAndDispatch` to re-enqueue readers. */
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

  /** Single site funneling transfer results into the store and fanning out
   *  to subscribers. Returns true iff the cell advanced. `delta` scopes
   *  nodeSet subscribers (default `key`); producers may pass a narrower
   *  delta when they know the change touches only a subset of `key`'s
   *  nodes. */
  private writeAndDispatch<K extends NodeSet, V>(
    analysis: Analysis<K, V>,
    key: K,
    value: V,
    context: AssumptionChain,
    delta: NodeSet = key,
  ): boolean {
    const result = storeWrite(analysis.store, key, value, context);
    if (result === null) return false;
    const source = analysis as Analysis<any, any>;
    // Re-enqueue read-tracked readers at the WRITE context — propagates
    // fact changes across speculation contexts.
    const readers = this.readEdges.get(source)?.get(key);
    if (readers !== undefined) {
      for (const r of readers) this.enqueue(r.analysis, r.key, context);
    }
    const ctx = this.ctxFor(context);
    const advanceSubs = this.advanceSubs.get(source);
    if (advanceSubs !== undefined) {
      for (const sub of advanceSubs) sub(ctx, key);
    }
    const nodeSubs = this.nodeSetSubs.get(source);
    if (nodeSubs !== undefined) {
      for (const sub of nodeSubs) {
        if (intersects(sub.interest, delta)) sub.fire(ctx, key);
      }
    }
    return true;
  }

  /** Sweep every registered transform over its dirty views once. Views that
   *  rewrote are scheduled for rebuild via the rule's `SweepKind`; structural
   *  rebuild itself is NOT flushed here. Public so online participants can
   *  run transforms before emitting bytecode. Returns true iff any rule
   *  fired. */
  sweepTransforms(): boolean {
    let anyFired = false;
    this.inTransformSweep = true;
    try {
      for (const r of this.transforms) {
        const { kind, dirty } = this.entryFor(r);
        if (dirty.size === 0) continue;
        for (const view of dirty) {
          const chain = kind.chainFor(view);
          if (this.isRefuted(chain)) continue;
          const fired = r.sweep(view, chain, this.functionManager);
          if (fired) {
            kind.scheduleRebuild(view);
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

  /** Allocate an `AnalysisCtx` bound to `context`. Generic surface only —
   *  no view-shape accessors. Consumers that need program shape acquire a
   *  `FunctionLocator` explicitly at `bind` time via `worklist.locate`. */
  private makeCtx(context: AssumptionChain): AnalysisCtx {
    const worklist = this;
    return {
      currentContext: context,
      read<K extends NodeSet, V>(analysis: Analysis<K, V>, key: K): V {
        worklist.recordReadEdge(analysis as Analysis<any, any>, key);
        return analysis.store.read(key, context);
      },
      tryRead<K extends NodeSet, V>(analysis: Analysis<K, V>, key: K): V | undefined {
        worklist.recordReadEdge(analysis as Analysis<any, any>, key);
        return analysis.store.tryRead(key, context);
      },
      readAll<K extends NodeSet, V>(analysis: Analysis<K, V>): ReadonlyMap<K, V> {
        // Whole-store read: cannot record per-key edges. Callers needing
        // fine-grained invalidation should read individual cells.
        return analysis.store.readAll(context);
      },
      readMinimal<K extends NodeSet, V>(
        analysis: Analysis<K, V>,
        key: K,
        accept: (value: V) => boolean,
      ): { value: V; witness: AssumptionChain } | undefined {
        worklist.recordReadEdge(analysis as Analysis<any, any>, key);
        return analysis.store.readMinimal(context, key, accept);
      },
      readDeepest<K extends NodeSet, V>(
        analysis: Analysis<K, V>,
        key: K,
      ): { value: V; witness: AssumptionChain } | undefined {
        worklist.recordReadEdge(analysis as Analysis<any, any>, key);
        return analysis.store.readDeepest(context, key);
      },
      write<K extends NodeSet, V>(analysis: Analysis<K, V>, key: K, value: V, delta?: NodeSet): boolean {
        return worklist.writeAndDispatch(analysis, key, value, context, delta);
      },
      evict<K extends NodeSet, V>(analysis: Analysis<K, V>, key: K): void {
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

  /** Re-seed Kildall for every context-sensitive entry-seed at `unit`'s
   *  entry block under `context`. Covers every registered narrowing plus any
   *  `extraEntrySeeds` passed in by the caller. */
  private enqueueNarrowingEntry(unit: Function, context: AssumptionChain): void {
    for (const n of this.narrowings) {
      const seed = n.blockAnalysis();
      this.enqueue(seed.env, seed.seed(unit), context);
    }
    for (const seed of this.extraEntrySeeds) {
      this.enqueue(seed.env, seed.seed(unit), context);
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

    const resolveUnit = this.unitResolverBySource.get(source) ?? defaultUnitResolver;
    const unit = resolveUnit(this.functionManager, key);
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
        this.functionManager.dispatch.clearFutureDispatchContext(unit);
        return ROOT_CONTEXT;
      }
      if (pruned === ROOT_CONTEXT) this.functionManager.dispatch.clearFutureDispatchContext(unit);
      else this.functionManager.dispatch.setFutureDispatchContext(unit, pruned);
      this.enqueueNarrowingEntry(unit, pruned);
      this.functionManager.dispatch.fireSpecRev(unit);
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
      this.functionManager.dispatch.clearFutureDispatchContext(unit);
      return ROOT_CONTEXT;
    }
    this.functionManager.dispatch.setFutureDispatchContext(unit, newCtx);
    this.enqueueNarrowingEntry(unit, newCtx);
    this.functionManager.dispatch.fireSpecRev(unit);
    return newCtx;
  }

  /** Preferred future-dispatch chain for `unit`. Delegates to manager. */
  futureDispatchChainFor(unit: Function): AssumptionChain {
    return this.functionManager.dispatch.futureDispatchChainFor(unit);
  }

  /** Same as `futureDispatchChainFor`, keyed by nodeId. */
  futureDispatchChainForNode(nodeId: NodeId): AssumptionChain {
    return this.functionManager.futureDispatchChainForNode(nodeId);
  }

  /** Drain to fixed point: analyses → transforms → analyses → CFG rebuild,
   *  iterated until no transform fires and no rebuild occurs. Returns the
   *  `FileInput | FunctionDef` nodes whose CFGs were rewired. Throws if
   *  `limit` rebuilds occur without converging. */
  drain(limit: number = Worklist.DEFAULT_DRAIN_LIMIT): ReadonlySet<StmtNS.FileInput | StmtNS.FunctionDef> {
    const changed = new Set<StmtNS.FileInput | StmtNS.FunctionDef>();
    let processed = 0;

    while (true) {
      this.processAnalysesToFixpoint();
      const fired = this.sweepTransforms();
      this.processAnalysesToFixpoint();
      const rebuilt = this.functionManager.flushPendingRebuilds();

      if (!fired && rebuilt.length === 0) break;

      for (const unit of rebuilt) {
        changed.add(unit.funcAst);
        processed++;
      }

      if (processed >= limit) {
        throw new Error(
          `[Worklist] drain exceeded ${limit} CFG rebuilds — likely a non-terminating transform cascade.`,
        );
      }
    }

    return changed;
  }

  static readonly DEFAULT_DRAIN_LIMIT = 1000;
}
