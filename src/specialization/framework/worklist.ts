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
  isRoot,
  Refutations,
  ROOT_CONTEXT,
  without,
  type AssumptionChain,
} from "../assumption";
import type { CounterStore } from "../observation/counter-store";
import type { ObservationBinding } from "../observation/observation-binding";
import type { ObservationChannel } from "../observation/observation-channel";
import type { NodeId, NodeSet } from "./analysis";
import { ANY_NODESET, intersects } from "../program/node-set";
import type { FunctionId } from "../program/program-view";
import {
  type Analysis,
  type AnalysisCtx,
  type EntrySeed,
  type Narrowing,
  type TransformRule,
} from "./analysis";
import { functionOfNodeId, type FunctionResolver } from "../program/program-view";
import type { ProgramCtx } from "../program/program-ctx";
import {
  storeEvict,
  storeWrite,
} from "./analysis-store";
import { type Function } from "../program/function";
import { FunctionViewManager } from "../program/views/function-view-manager";

/** Catches misregistration: only Analyses carry `polarity`. */
function assertNoPolarity(thing: object, site: string, kind: string): void {
  if ("polarity" in thing) {
    throw new Error(
      `[Worklist.${site}] ${kind} must not carry \`polarity\` — that field is Analysis-only.`,
    );
  }
}

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
  readonly functionViews: FunctionViewManager;

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
  private readonly transformDirty = new Map<TransformRule, Set<Function>>();

  /** Reentrancy guard: set while `sweepTransforms` runs. `publish`/`bump`
   *  throw when true — observation ingress mid-sweep would shift
   *  `futureDispatchChainFor(unit)` under the sweep's feet. */
  private inTransformSweep = false;

  /** Fact-change, counter-bump, and channel-publish dispatch indices.
   *  Analyses' and transforms' subscriptions compile into callbacks here. */
  private readonly factSubs = new Map<
    Analysis<any, any>,
    Array<(ctx: AnalysisCtx, key: unknown) => void>
  >();
  /** Delta-routed subscribers. Each entry declares an `interest` as a
   *  `NodeSet` (typically a view: a block, a function, or an interned
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
  private readonly counterSubs = new Map<
    CounterStore<any>,
    Array<(ctx: AnalysisCtx, key: unknown) => void>
  >();
  private readonly registeredCounters = new Set<CounterStore<any>>();

  /** Refutation filter (minimal generators; `contains(c) = ∃ r. leq(r, c)`). */
  private readonly refutations: Refutations = new Refutations();

  // ── Backward-compat delegates to the function-view manager ─────────
  get functions(): ReadonlyMap<FunctionId, Function> {
    return this.functionViews.functions;
  }

  functionOfNode(nodeId: NodeId): Function | undefined {
    return this.functionViews.functionOfNode(nodeId);
  }

  private readonly narrowings: ReadonlyArray<Narrowing<any, any>>;
  /** Extra entry-seed pairs re-enqueued at every narrowing-entry alongside
   *  each narrowing's own `blockAnalysis()`. Used for context-sensitive
   *  analyses (e.g. purity) that must track each specialization context
   *  but aren't themselves narrowings. Policy-owned by the caller. */
  private readonly extraEntrySeeds: ReadonlyArray<EntrySeed>;
  /** Per-source unit resolver; all bindings on a source must agree. */
  private readonly unitResolverBySource: Map<
    ObservationChannel<any, any>,
    FunctionResolver<any>
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
    const unitResolverBySource = new Map<ObservationChannel<any, any>, FunctionResolver<any>>();
    const bindingsBySource = new Map<ObservationChannel<any, any>, ObservationBinding<any, any>[]>();
    for (const b of observationBindings) {
      const source = b.source;
      const resolver: FunctionResolver<any> = b.resolveUnit ?? functionOfNodeId;
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
    // Build the function-view manager FIRST: registrations below depend on
    // the initial mint burst it fires when subscribers register via
    // `onMint`. Manager constructor builds Functions from `ast`.
    this.functionViews = new FunctionViewManager(ast, functionEnvironments);

    for (const p of analyses) this.register(p);
    for (const c of counters) this.registerCounter(c);
    for (const ch of channels) this.registerChannel(ch);
    for (const r of transforms) this.registerTransform(r);
  }

  /** Register a structurally-introduced FunctionDef. Delegates to the
   *  function-view manager, which builds the unit and fires its mint subs. */
  addFunction(node: StmtNS.FunctionDef, chain: AssumptionChain): Function {
    return this.functionViews.addFunction(node, chain);
  }

  private dirtyFor(rule: TransformRule): Set<Function> {
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

  /** Subscribe to refutation events. Delegates to the function-view manager. */
  onRefute(callback: (unit: Function, carrier: AssumptionChain) => void): void {
    this.functionViews.onRefute(callback);
  }

  /** Refute `carrier` for `unit`: add the minimal singleton of the carrier's
   *  tip binding, then ask the manager to fire refute subscribers and drop
   *  the unit's futureDispatchContext if it now points into the refuted
   *  subtree. Body eviction is lazy. Idempotent. */
  private refute(unit: Function, carrier: AssumptionChain): void {
    if (carrier === ROOT_CONTEXT) return;
    // MINIMAL generators: storing the full carrier chain would under-refute
    // — sibling chains carrying the same refuted binding under a different
    // prefix would escape `isRefuted`.
    const a = carrier.assumption!;
    const minimal = extend(ROOT_CONTEXT, a.narrowing, a.key, a.value);
    this.refutations.add(minimal);
    this.functionViews.refuteSubscribersAndReconcileDispatch(unit, carrier, this.refutations);
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

  /** Subscribe `reader` to advancing writes on `from`. The reader fires
   *  iff `intersects(interest, delta)` where `delta` defaults to the write's
   *  key. Pass `ANY_NODESET` for whole-key fan-out (every advance);
   *  pass a view (block/function) or `internSingletonNode(id)` for narrow
   *  interest.
   *
   *  `dirtied(ctx, key)` projects the upstream key-change into the reader's
   *  key space.
   *
   *  `opts.enqueueAt` projects the source context into the enqueue context;
   *  default is the context the upstream write happened in. Use
   *  `enqueueAt: () => ROOT_CONTEXT` for context-blind readers.
   *
   *  When the reader cares about a strict subset of the source's value space
   *  (the IMPURE_SENTINEL pattern), the reader should read the source via
   *  `analysis.store` directly inside `transfer` so it doesn't ALSO record an
   *  auto read-edge — that would defeat the delta-routing savings. */
  subscribe<K extends NodeSet>(
    from: Analysis<any, any>,
    reader: Analysis<K, any>,
    interest: NodeSet,
    dirtied: (ctx: AnalysisCtx, key: unknown) => Iterable<K>,
    opts?: { enqueueAt?: (sourceCtx: AssumptionChain) => AssumptionChain },
  ): void {
    const project = opts?.enqueueAt;
    const fire = (ctx: AnalysisCtx, key: unknown): void => {
      const enqueueCtx = project !== undefined ? project(ctx.currentContext) : ctx.currentContext;
      for (const k of dirtied(ctx, key)) this.enqueue(reader, k, enqueueCtx);
    };
    let list = this.nodeSetSubs.get(from);
    if (list === undefined) {
      list = [];
      this.nodeSetSubs.set(from, list);
    }
    list.push({ interest, fire });
  }

  /** Subscribe `reader` to mint of any unit. Fires immediately against every
   *  existing unit at registration so late subscribers pick up the initial
   *  burst. */
  onMint<K extends NodeSet>(
    reader: Analysis<K, any>,
    dirtied: (ctx: AnalysisCtx, unit: Function) => Iterable<K>,
  ): void {
    this.functionViews.onMint(unit => {
      for (const k of dirtied(this.passCtx, unit)) this.enqueue(reader, k, ROOT_CONTEXT);
    });
  }

  /** Subscribe `reader` to rebuild of any unit. Distinct from mint because
   *  rebuild-time invalidation often needs a paired `onRebuildEvict`. */
  onRebuildDirty<K extends NodeSet>(
    reader: Analysis<K, any>,
    dirtied: (ctx: AnalysisCtx, unit: Function) => Iterable<K>,
  ): void {
    this.functionViews.onRebuild(unit => {
      for (const k of dirtied(this.passCtx, unit)) this.enqueue(reader, k, ROOT_CONTEXT);
    });
  }

  /** Subscribe an evict callback to rebuild. Typically used to drop block-
   *  keyed cells whose `BasicBlock` identities belong to the pre-rebuild CFG. */
  onRebuildEvict(evict: (unit: Function) => void): void {
    this.functionViews.onRebuild(evict);
  }

  /** Subscribe `reader` to spec-context bumps on any unit. Fires when
   *  observation-driven extension mutates `futureDispatchContext`. */
  onSpecRev<K extends NodeSet>(
    reader: Analysis<K, any>,
    dirtied: (ctx: AnalysisCtx, unit: Function) => Iterable<K>,
  ): void {
    this.functionViews.onSpecRev(unit => {
      for (const k of dirtied(this.passCtx, unit)) this.enqueue(reader, k, ROOT_CONTEXT);
    });
  }

  /** Register an analysis. Idempotent. */
  register<K extends NodeSet, V>(analysis: Analysis<K, V>): void {
    const a = analysis as Analysis<any, any>;
    if (this.registeredAnalyses.has(a)) return;
    this.registeredAnalyses.add(a);
    analysis.bind?.(this);
  }

  /** Register a transform rule. Idempotent. Auto-installs mint/rebuild
   *  dirtying for the rule's own unit, then lets the rule subscribe via `bind`. */
  registerTransform(rule: TransformRule): void {
    assertNoPolarity(rule, "registerTransform", "rules");
    if (this.transformsSet.has(rule)) return;
    this.transformsSet.add(rule);
    this.transforms.push(rule);
    const dirty = new Set<Function>();
    this.transformDirty.set(rule, dirty);

    const addUnit = (unit: Function): void => { dirty.add(unit); };
    this.functionViews.onMint(addUnit);
    this.functionViews.onRebuild(addUnit);
    rule.bind?.(this);
  }

  /** Mirror of `onFactDirty` for transforms. */
  onTransformFactDirty<K extends NodeSet>(
    rule: TransformRule,
    from: Analysis<K, any>,
    dirtied: (ctx: AnalysisCtx, key: K) => Iterable<Function>,
  ): void {
    const dirty = this.dirtyFor(rule);
    Worklist.addSub(this.factSubs, from as Analysis<any, any>, (ctx, key) => {
      for (const u of dirtied(ctx, key as K)) dirty.add(u);
    });
  }

  /** Register a counter. Idempotent. */
  registerCounter<K>(counter: CounterStore<K>): void {
    assertNoPolarity(counter, "registerCounter", "counters");
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
  onTransformCounterBumped<K>(rule: TransformRule,
    counter: CounterStore<K>,
    dirtied: (ctx: AnalysisCtx, key: K) => Iterable<Function>,
  ): void {
    const dirty = this.dirtyFor(rule);
    Worklist.addSub(this.counterSubs, counter as CounterStore<any>, (ctx, key) => {
      for (const u of dirtied(ctx, key as K)) dirty.add(u);
    });
  }

  /** Public read surface — thin delegation to the analysis's canonical
   *  read method. `context` is mandatory: the worklist does not guess which
   *  chain position a caller meant. */
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
    assertNoPolarity(channel, "registerChannel", "channels");
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
   *  them out to subscribers. Returns true iff the cell advanced.
   *
   *  `delta` scopes nodeSet subscribers: an entry fires only if its
   *  `interest` intersects `delta`. Default is `key` itself — every
   *  analysis key already extends `NodeSet`, and an advance at key K is
   *  by construction an advance over the nodes K covers. Producers can
   *  pass a narrower `delta` when they know the change touches only a
   *  subset of the key's nodes (e.g. dfa-factory's per-fact delta). */
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
    // Read-tracked readers of (analysis, key) — re-enqueue at the WRITE
    // context, matching `onFactDirty`'s default. This is what propagates
    // fact changes across speculation contexts: a reader originally run at
    // ROOT gets re-enqueued at specCtx when its input advances at specCtx.
    const readers = this.readEdges.get(source)?.get(key);
    if (readers !== undefined) {
      for (const r of readers) this.enqueue(r.analysis, r.key, context);
    }
    const ctx = this.ctxFor(context);
    const subs = this.factSubs.get(source);
    if (subs !== undefined) {
      for (const sub of subs) sub(ctx, key);
    }
    const nodeSubs = this.nodeSetSubs.get(source);
    if (nodeSubs !== undefined) {
      for (const sub of nodeSubs) {
        // ANY_NODESET means "fire on every advance, regardless of which
        // nodes changed" — used for cell-identity dependencies (e.g. CFG
        // self-wake) where the key is a graph node, not a NodeSet membership
        // claim. Skip the intersection so empty-nodeIds keys (e.g. an
        // exit block with no statements) still fire downstream.
        if (sub.interest === ANY_NODESET || intersects(sub.interest, delta)) {
          sub.fire(ctx, key);
        }
      }
    }
    return true;
  }

  /** Sweep every registered transform over its dirty functions once. Units that
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
          const fired = r.sweep(unit, chain, this);
          if (fired) {
            this.functionViews.schedulePendingRebuild(unit);
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

  /** Allocate a `ProgramCtx` bound to `context`. The framework's `Analysis`
   *  signature only promises `AnalysisCtx`; the runtime constructs the richer
   *  `ProgramCtx` (which adds `functions` and `functionOfNode`) and analyses
   *  cast via `asProgramCtx` at access. */
  private makeCtx(context: AssumptionChain): ProgramCtx {
    const worklist = this;
    // Use getters for `functions`/`functionOfNode` so the ctx works even
    // when constructed before `functionViews` is assigned (passCtx is a
    // class-field initializer that runs before the constructor body).
    return {
      get functions() { return worklist.functions; },
      functionOfNode: (nodeId: NodeId) => worklist.functionOfNode(nodeId),
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
        // Whole-store read: cannot record per-key edges without knowing the
        // keyspace. Callers needing fine-grained invalidation should read
        // individual cells. Today no analysis transfer uses readAll; if that
        // changes, pair the readAll with explicit onFactDirty until a
        // "depends on all keys" edge is modeled.
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

    const resolveUnit = this.unitResolverBySource.get(source) ?? functionOfNodeId;
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
        this.functionViews.clearFutureDispatchContext(unit);
        return ROOT_CONTEXT;
      }
      if (pruned === ROOT_CONTEXT) this.functionViews.clearFutureDispatchContext(unit);
      else this.functionViews.setFutureDispatchContext(unit, pruned);
      this.enqueueNarrowingEntry(unit, pruned);
      this.functionViews.fireSpecRev(unit);
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
      this.functionViews.clearFutureDispatchContext(unit);
      return ROOT_CONTEXT;
    }
    this.functionViews.setFutureDispatchContext(unit, newCtx);
    this.enqueueNarrowingEntry(unit, newCtx);
    this.functionViews.fireSpecRev(unit);
    return newCtx;
  }

  /** Preferred future-dispatch chain for `unit`. Delegates to manager. */
  futureDispatchChainFor(unit: Function): AssumptionChain {
    return this.functionViews.futureDispatchChainFor(unit);
  }

  /** Same as `futureDispatchChainFor`, keyed by nodeId. */
  futureDispatchChainForNode(nodeId: NodeId): AssumptionChain {
    return this.functionViews.futureDispatchChainForNode(nodeId);
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
      const rebuilt = this.functionViews.flushPendingRebuilds();

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
