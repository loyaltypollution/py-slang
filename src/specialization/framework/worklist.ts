// Driver for analysis-graph dispatch: registration façade, fan-out maps,
// transform sweep, per-unit speculation state, and fixpoint driver.
//
// Function is the only unit kind — see `../publication.ts` for the
// OSR-impossibility constraint that pins this. The worklist could in
// principle be parametric over a unit kind, but with no second
// inhabitant on the horizon, generality was paying its keep only as
// type noise.

import type { StmtNS } from "../../ast-types";
import type { FunctionEnvironments } from "../../resolver";
import {
  carrier as carrierOf,
  extend,
  isRoot,
  Refutations,
  ROOT_CONTEXT,
  without,
} from "../assumption";
import type { AssumptionChain } from "../assumption";
import type { SaturatingCounter } from "../observation/counter-store";
import type { ObservationSource } from "../observation/observation-channel";
import type { NodeSet } from "./analysis";
import { intersects } from "../program/node-set";
import type {
  Analysis,
  AnalysisBindCtx,
  AnalysisCtx,
  EntrySeed,
  Narrowing,
  TransformBindCtx,
  TransformRule,
} from "./analysis";
import { storeEvict, storeWrite } from "./analysis-store";
import type { Function } from "../program/function/function";
import { FunctionManager, type FunctionLocator } from "../program/function/manager";
import type { FunctionDomain } from "./function-domain";

/** Refute-event callback: fired when an observation invalidates a chain
 *  carrier under `unit`. Memoization-style consumers evict caches keyed on
 *  the carrier. */
export type RefuteListener = (unit: Function, carrier: AssumptionChain) => void;

/** Chain-change callback: fired after `applyObservation` settles `unit` on
 *  a new preferred chain. `newChain` is the post-observation chain — the
 *  context narrowing-driven reseeds enqueue at. */
type ChainChangeListener = (unit: Function, newChain: AssumptionChain) => void;

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

  size(): number {
    return this.items.length - this.head;
  }

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

/** Construction payload for `Worklist`. The worklist builds a
 *  `FunctionManager` from `ast` and `functionEnvironments`. */
export interface WorklistConfig {
  readonly ast: StmtNS.FileInput;
  readonly functionEnvironments: FunctionEnvironments;

  readonly analyses: ReadonlyArray<Analysis<any, any>>;
  readonly transforms: ReadonlyArray<TransformRule>;
  /** Production narrowings. Each carries `blockAnalysis` (worklist reseed)
   *  plus `source`/`lift`/`resolveUnit` (observation ingress glue). */
  readonly narrowings?: ReadonlyArray<Narrowing<any, any, any>>;
  /** Extra entry-seed pairs re-enqueued at every narrowing-entry alongside
   *  each narrowing's own `blockAnalysis()`. Used for context-sensitive
   *  analyses (e.g. purity) that must track each specialization context
   *  but aren't themselves narrowings. Policy-owned by the caller. */
  readonly extraEntrySeeds?: ReadonlyArray<EntrySeed>;
}

export class Worklist {
  /** The Function domain this worklist drives. All lifecycle / chain /
   *  refute / rebuild orchestration routes through this contract, so the
   *  worklist proper does not depend on FunctionManager directly. Public
   *  for unit enumeration; mutation/observation routes through bind ctxes. */
  readonly units: FunctionDomain;

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

  /** Registered transforms and their per-rule dirty sets. A unit enters its
   *  set on extent-change (mint or rebuild) or on a write to an upstream
   *  analysis the rule subscribes to; sweep clears it. */
  private readonly transforms: TransformRule[] = [];
  private readonly transformsSet = new Set<TransformRule>();
  private readonly transformDirty = new Map<TransformRule, Set<Function>>();

  /** Reentrancy guard: set while `sweepTransforms` runs. `observe` and
   *  `incrementPolicyCounter` throw when true — observation ingress
   *  mid-sweep would shift `futureDispatchChainFor(unit)` under the
   *  sweep's feet. */
  private inTransformSweep = false;

  /** Node-intersection-routed subscribers. Each entry declares an `interest`
   *  as a `NodeSet` (typically a predicate sentinel or an interned id-set view).
   *  The entry fires when an advancing write to the source publishes a `delta`
   *  such that `intersects(delta, interest)`. Producers writing to a source
   *  that has any subscriber here MUST pass an explicit `delta` to
   *  `ctx.write`; the worklist throws on a NodeSet-routed write with no delta
   *  (no implicit `delta = key` default — keys are opaque). Sources without
   *  NodeSet subscribers can omit `delta` freely. */
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
  private readonly policyCounterSubs = new Map<
    SaturatingCounter<any>,
    Array<(ctx: AnalysisCtx, key: unknown) => void>
  >();

  /** Per-unit speculation state. `futureByUnit` holds each unit's preferred
   *  future-dispatch chain (absent ⇒ `ROOT_CONTEXT`); `refutations` is the
   *  algebraic filter — `c` is refuted iff some generator is a subset.
   *  Mutated only by `observe`. */
  private readonly futureByUnit = new Map<Function, AssumptionChain>();
  private readonly refutations = new Refutations();
  private readonly narrowings: ReadonlyArray<Narrowing<any, any, any>>;
  /** Source → narrowing index. Production wires at most one narrowing per
   *  source (disjoint sources), so this is a direct lookup, not a fan-out. */
  private readonly narrowingBySource = new Map<
    ObservationSource<any, any>,
    Narrowing<any, any, any>
  >();

  /** Chain-change subscribers fan out when an observation settles a unit on
   *  a new preferred chain. Auto-installed entries (per narrowing and per
   *  `extraEntrySeed`) re-enqueue at `newChain` so context-sensitive reseeds
   *  run under the new context; explicit `wl.onChainChange` consumers
   *  re-enqueue at `ROOT_CONTEXT` (cell-identity wakes, not context-sensitive
   *  reseeds). */
  private readonly chainSubs: ChainChangeListener[] = [];
  private readonly refuteSubs: RefuteListener[] = [];

  /** Read surface for function lookups — the single entry point. Internal
   *  callers use `this.locate`; external callers use `worklist.locate`.
   *  Transfers receive it as `ctx.locator`; transforms / narrowings receive
   *  it as a parameter to their dirty/sweep/resolveUnit callbacks. */
  get locate(): FunctionLocator {
    return this.units.locator;
  }

  constructor(config: WorklistConfig) {
    const {
      ast,
      functionEnvironments,
      analyses,
      transforms,
      narrowings = [],
      extraEntrySeeds = [],
    } = config;
    // Build the unit domain FIRST: analysis registrations below depend on
    // the initial extent-change burst FunctionManager fires when subscribers
    // register via `onExtentChange`.
    this.units = new FunctionManager(ast, functionEnvironments);
    this.narrowings = narrowings;
    for (const n of narrowings) {
      if (this.narrowingBySource.has(n.source)) {
        throw new Error(
          `[Worklist] multiple narrowings on the same ObservationSource — production assumes disjoint sources.`,
        );
      }
      this.narrowingBySource.set(n.source, n);
    }

    // Auto-install per-narrowing chain-change reseeds. Each narrowing
    // declares an `EntrySeed` (`blockAnalysis()`); on chain change we
    // re-enqueue that seed at the unit under the new chain. `extraEntrySeeds`
    // ride the same mechanism — they're context-sensitive analyses (e.g.
    // purity) that need re-seeding at every narrowing-entry but aren't
    // themselves narrowings.
    for (const n of narrowings) this.installEntrySeedReseed(n.blockAnalysis());
    for (const seed of extraEntrySeeds) this.installEntrySeedReseed(seed);

    for (const p of analyses) this.register(p);
    for (const r of transforms) this.registerTransform(r);
  }

  private installEntrySeedReseed(seed: EntrySeed): void {
    this.chainSubs.push((unit, newChain) => {
      this.enqueue(seed.env, seed.seed(unit), newChain);
    });
  }

  private dirtyFor(rule: TransformRule): Set<Function> {
    const d = this.transformDirty.get(rule);
    if (d === undefined) throw new Error(`[Worklist] missed registerTransform`);
    return d;
  }

  /** Preferred future-dispatch chain for `unit`. `ROOT_CONTEXT` if none. */
  private chainFor(unit: Function): AssumptionChain {
    return this.futureByUnit.get(unit) ?? ROOT_CONTEXT;
  }

  /** `c` is refuted iff any generator is an algebraic subset. */
  isRefuted(node: AssumptionChain): boolean {
    return this.refutations.contains(node);
  }

  /** Subscribe to refutation events. */
  onRefute(callback: RefuteListener): void {
    this.refuteSubs.push(callback);
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
   *  delta intersects `interest` (typically a view over a block / function
   *  extent, or a one-off singleton over a sentinel id). `dirtied` projects
   *  the source key-change into reader keys. Readers re-enqueue at the source
   *  write context.
   *
   *  HAZARD: synthetic CFG blocks (entry/exit/joins) have empty `nodeIds`;
   *  do not wrap them via `nodeSetOfIds(block.nodeIds)` for an interest —
   *  the resulting predicate is vacuously absent. Use `subscribeOnAdvance`
   *  for cell-identity wakes on those. */
  subscribe<K>(
    from: Analysis<any, any>,
    reader: Analysis<K, any>,
    interest: NodeSet,
    dirtied: (locator: FunctionLocator, key: unknown) => Iterable<K>,
  ): void {
    const fire = (ctx: AnalysisCtx, key: unknown): void => {
      for (const k of dirtied(this.locate, key)) {
        this.enqueue(reader, k, ctx.currentContext);
      }
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
  subscribeOnAdvance<K>(
    from: Analysis<any, any>,
    reader: Analysis<K, any>,
    dirtied: (locator: FunctionLocator, key: unknown) => Iterable<K>,
  ): void {
    Worklist.addSub(this.advanceSubs, from, (ctx, key) => {
      for (const k of dirtied(this.locate, key)) {
        this.enqueue(reader, k, ctx.currentContext);
      }
    });
  }

  /** Subscribe `reader` to mint and rebuild on any unit. Fires for every
   *  existing unit at registration so late subscribers replay the mint
   *  burst. Subscribers that need to distinguish mint from rebuild
   *  bypass this and go through `units.onExtentChange` directly. */
  onExtentChange<K>(
    reader: Analysis<K, any>,
    dirtied: (locator: FunctionLocator, unit: Function) => Iterable<K>,
  ): void {
    this.units.onExtentChange((unit) => {
      for (const k of dirtied(this.locate, unit)) this.enqueue(reader, k, ROOT_CONTEXT);
    });
  }

  /** Subscribe `reader` to chain changes on any unit's preferred future-
   *  dispatch chain. Fires when observation-driven extension mutates
   *  `dispatchState`. Re-enqueues at `ROOT_CONTEXT` — cell-identity wakes
   *  for downstream analyses that don't themselves participate in the
   *  speculation context. Narrowing-driven reseeds use the auto-installed
   *  path in the constructor and re-enqueue at the new chain instead. */
  onChainChange<K>(
    reader: Analysis<K, any>,
    dirtied: (locator: FunctionLocator, unit: Function) => Iterable<K>,
  ): void {
    this.chainSubs.push((unit, _newChain) => {
      for (const k of dirtied(this.locate, unit)) this.enqueue(reader, k, ROOT_CONTEXT);
    });
  }

  /** Register an analysis. Idempotent. */
  private register<K, V>(analysis: Analysis<K, V>): void {
    const a = analysis as Analysis<any, any>;
    if (this.registeredAnalyses.has(a)) return;
    this.registeredAnalyses.add(a);
    analysis.bind?.(this.makeAnalysisBindCtx());
  }

  /** Register a transform rule. Idempotent. Auto-installs extent-change
   *  dirtying so each unit enters the rule's dirty set on mint and rebuild,
   *  then lets the rule subscribe via `bind`. */
  registerTransform(rule: TransformRule): void {
    if (this.transformsSet.has(rule)) return;
    this.transformsSet.add(rule);
    this.transforms.push(rule);
    const dirty = new Set<Function>();
    this.transformDirty.set(rule, dirty);
    this.units.onExtentChange((unit) => {
      dirty.add(unit);
    });
    rule.bind?.(this.makeTransformBindCtx(rule));
  }

  /** Build a narrow registration surface for `Analysis.bind`. Exposes the
   *  flag-carrying `onExtentChange` plus the chain/fact subscription methods
   *  analyses need; withholds read/write/observe powers that belong to the
   *  full Worklist. */
  private makeAnalysisBindCtx(): AnalysisBindCtx {
    const wl = this;
    return {
      onExtentChange(cb): void {
        wl.units.onExtentChange(cb);
      },
      enqueue(analysis, key): void {
        wl.enqueue(analysis, key, ROOT_CONTEXT);
      },
      onChainChange(reader, dirtied): void {
        wl.onChainChange(reader, dirtied);
      },
      subscribe(from, reader, interest, dirtied): void {
        wl.subscribe(from, reader, interest, dirtied);
      },
      subscribeOnAdvance(from, reader, dirtied): void {
        wl.subscribeOnAdvance(from, reader, dirtied);
      },
    };
  }

  /** Build a narrow registration surface for `TransformRule.bind`. Exposes
   *  only the dirtying / refute-listener entry points a transform needs. */
  private makeTransformBindCtx(rule: TransformRule): TransformBindCtx {
    const wl = this;
    return {
      onTransformFactDirty(_rule, from, dirtied): void {
        wl.onTransformFactDirty(rule, from, dirtied);
      },
      onPolicyCounterAdvance(_rule, counter, dirtied): void {
        wl.onPolicyCounterAdvance(rule, counter, dirtied);
      },
      onRefute(cb): void {
        wl.onRefute(cb);
      },
    };
  }

  /** Transform-side fact-dirty: when `from` advances, add the projected
   *  units to `rule`'s dirty set. Cell-identity dependency. */
  onTransformFactDirty<K>(
    rule: TransformRule,
    from: Analysis<K, any>,
    dirtied: (locator: FunctionLocator, key: K) => Iterable<Function>,
  ): void {
    const dirty = this.dirtyFor(rule);
    Worklist.addSub(this.advanceSubs, from as Analysis<any, any>, (_ctx, key) => {
      for (const v of dirtied(this.locate, key as K)) dirty.add(v);
    });
  }

  /** Increment `counter[key]` by 1, clamped at `counter.max`. Fires
   *  subscribers only when the counter advances. */
  incrementPolicyCounter<K>(counter: SaturatingCounter<K>, key: K): void {
    if (this.inTransformSweep) {
      throw new Error(
        `[Worklist.incrementPolicyCounter] mid-sweep observation ingress is forbidden`,
      );
    }
    const advanced = counter.increment(key);
    if (!advanced) return;
    const subs = this.policyCounterSubs.get(counter as SaturatingCounter<any>);
    if (subs !== undefined) {
      for (const subscriber of subs) subscriber(this.passCtx, key);
    }
    this.processAnalysesToFixpoint();
  }

  /** Subscribe a transform to policy-counter advances. */
  onPolicyCounterAdvance<K>(
    rule: TransformRule,
    counter: SaturatingCounter<K>,
    dirtied: (locator: FunctionLocator, key: K) => Iterable<Function>,
  ): void {
    const dirty = this.dirtyFor(rule);
    Worklist.addSub(this.policyCounterSubs, counter as SaturatingCounter<any>, (_ctx, key) => {
      for (const unit of dirtied(this.locate, key as K)) dirty.add(unit);
    });
  }

  /** Public read surface — delegates to `analysis.store.tryRead`. */
  tryRead<K, V>(
    analysis: Analysis<K, V>,
    key: K,
    context: AssumptionChain,
  ): V | undefined {
    return analysis.store.tryRead(key, context);
  }

  /** Record a runtime observation event made under `context`. Extends or
   *  prunes the owning unit's speculation context via every narrowing bound
   *  on `source`, then drives analyses to fixpoint.
   *
   *  Returns the caller's next frame-local provenance chain (extended or
   *  pruned). */
  observe<K, V>(
    source: ObservationSource<K, V>,
    key: K,
    observed: V,
    context: AssumptionChain,
  ): AssumptionChain {
    if (this.inTransformSweep) {
      throw new Error(`[Worklist.observe] mid-sweep observation ingress is forbidden`);
    }
    const nextContext = this.applyObservation(source, key, observed, context);
    this.processAnalysesToFixpoint();
    return nextContext;
  }

  /** Extend or prune `unit`'s preferred chain via every narrowing bound on
   *  `source`. Mutates `futureByUnit`/`refutations`, fires refute subs in
   *  loop and chain-change subs at the end. The "refuted-final" branch
   *  clears the unit's preferred chain but does NOT fire chain-change — the
   *  chain has gone ROOT, but downstream re-seed at ROOT is not what
   *  consumers expect from a chain *change* event. */
  private applyObservation<V>(
    source: ObservationSource<any, V>,
    key: any,
    observed: V,
    parent: AssumptionChain,
  ): AssumptionChain {
    const narrowing = this.narrowingBySource.get(source);
    if (narrowing === undefined) return parent;
    const unit = narrowing.resolveUnit(this.locate, key);
    if (unit === undefined) return parent;

    const priorChain = this.chainFor(unit);
    const newCtx = source.isUnknown(observed)
      ? this.pruneFor(unit, narrowing, key, parent)
      : this.extendFor(unit, narrowing, key, observed, parent);

    if (newCtx === parent) return parent;
    if (this.refutations.contains(newCtx)) {
      this.futureByUnit.delete(unit);
      return ROOT_CONTEXT;
    }
    if (isRoot(newCtx)) this.futureByUnit.delete(unit);
    else this.futureByUnit.set(unit, newCtx);
    if (priorChain !== newCtx) {
      for (const sub of this.chainSubs) sub(unit, newCtx);
    }
    return newCtx;
  }

  /** Prune `(n, key)` binding from `parent`, refuting the carrier of the
   *  pinned binding before dropping it. */
  private pruneFor(
    unit: Function,
    n: Narrowing<any, any, any>,
    key: any,
    parent: AssumptionChain,
  ): AssumptionChain {
    const c = carrierOf(parent, n, key);
    if (c !== undefined) this.refute(unit, c);
    return without(parent, n, key);
  }

  /** Extend `parent` with the lifted observation, refuting and replacing
   *  any conflicting prior binding. */
  private extendFor<V>(
    unit: Function,
    n: Narrowing<any, any, any>,
    key: any,
    observed: V,
    parent: AssumptionChain,
  ): AssumptionChain {
    const lifted = n.lift(observed);
    if (lifted === undefined) return parent;
    const c = carrierOf(parent, n, key);
    const existing = c?.assumption?.value;
    if (c !== undefined && n.eq(existing, lifted)) return parent;
    if (c !== undefined) {
      // Refute the carrier of the stale binding before splicing it out —
      // a conflicting concrete observation violates it.
      this.refute(unit, c);
    }
    const cleaned = c !== undefined ? without(parent, n, key) : parent;
    return extend(cleaned, n, key, lifted);
  }

  /** Refute `carrier` for `unit`: add the minimal singleton of the carrier's
   *  tip binding (full chain would under-refute — siblings carrying the same
   *  binding under a different prefix would escape `isRefuted`), fire refute
   *  subscribers, then reconcile the unit's preferred chain by clearing it
   *  if it's now refuted. Idempotent. */
  private refute(unit: Function, carrier: AssumptionChain): void {
    if (isRoot(carrier)) return;
    const a = carrier.assumption;
    this.refutations.add(extend(ROOT_CONTEXT, a.narrowing, a.key, a.value));
    for (const sub of this.refuteSubs) sub(unit, carrier);
    const fdCtx = this.chainFor(unit);
    if (!isRoot(fdCtx) && this.refutations.contains(fdCtx)) {
      this.futureByUnit.delete(unit);
    }
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

  /** The currently-transferring (analysis, key); lets `ctx.read*` record
   *  read-edges without threading the reader through `AnalysisCtx`. Context
   *  is intentionally NOT recorded: a reader that ran at C1 must re-run at
   *  ANY context where the source it read advances, because chain-walking
   *  reads mean the reader's result needs to land at every context where
   *  the source advanced. Recording reader context (Salsa-style precision)
   *  would prevent context-sensitive analyses from ever computing under
   *  speculation contexts — pinned by purity.test.ts and
   *  memoization-under-spec.test.ts, which fail if context is added here. */
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
   *  to subscribers. Returns true iff the cell advanced. If the source has
   *  any `subscribe()` reader, the producer MUST pass a `delta` — the
   *  worklist throws otherwise. Sources with only `subscribeOnAdvance`
   *  readers (or none) can omit `delta`. */
  private writeAndDispatch<K, V>(
    analysis: Analysis<K, V>,
    key: K,
    value: V,
    context: AssumptionChain,
    delta?: NodeSet,
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
    if (nodeSubs !== undefined && nodeSubs.length > 0) {
      if (delta === undefined) {
        throw new Error(
          `[Worklist.writeAndDispatch] source has subscribe()-style readers but write supplied no delta. Pass an explicit delta to ctx.write, or use subscribeOnAdvance for cell-identity wakes.`,
        );
      }
      for (const sub of nodeSubs) {
        if (intersects(sub.interest, delta)) sub.fire(ctx, key);
      }
    }
    return true;
  }

  /** Sweep every registered transform over its dirty units once. Canonical
   *  rewrites schedule rebuild; speculative-variant rewrites do not rebuild
   *  CFG state. Structural rebuild itself is NOT flushed here. Private:
   *  online callers go through `drain()` for a coherent post-barrier state.
   *  Returns `true` iff any rule changed any body. */
  private sweepTransforms(): boolean {
    let anyFired = false;
    this.inTransformSweep = true;
    try {
      for (const rule of this.transforms) {
        const dirty = this.dirtyFor(rule);
        if (dirty.size === 0) continue;
        for (const unit of dirty) {
          const chain = this.chainFor(unit);
          if (this.refutations.contains(chain)) continue;
          const result = rule.sweep(unit, chain, this.locate);
          if (!result.changed) continue;
          anyFired = true;
          if (result.canonicalChanged) {
            this.units.scheduleRebuild(unit);
          }
        }
        dirty.clear();
      }
    } finally {
      this.inTransformSweep = false;
    }
    return anyFired;
  }

  /** Allocate an `AnalysisCtx` bound to `context`. Carries the program-shape
   *  read surface (`locator`); richer worklist powers stay off ctx. */
  private makeCtx(context: AssumptionChain): AnalysisCtx {
    const worklist = this;
    return {
      currentContext: context,
      // Lazy: `passCtx` is initialized as a class field, before the
      // constructor body sets `this.units`. Reads happen later, by which
      // time the manager is in place.
      get locator() { return worklist.locate; },
      read<K, V>(analysis: Analysis<K, V>, key: K): V {
        worklist.recordReadEdge(analysis as Analysis<any, any>, key);
        return analysis.store.read(key, context);
      },
      tryRead<K, V>(analysis: Analysis<K, V>, key: K): V | undefined {
        worklist.recordReadEdge(analysis as Analysis<any, any>, key);
        return analysis.store.tryRead(key, context);
      },
      readAll<K, V>(analysis: Analysis<K, V>): ReadonlyMap<K, V> {
        // Whole-store read: cannot record per-key edges. Callers needing
        // fine-grained invalidation should read individual cells.
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
      write<K, V>(
        analysis: Analysis<K, V>,
        key: K,
        value: V,
        delta?: NodeSet,
      ): boolean {
        return worklist.writeAndDispatch(analysis, key, value, context, delta);
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
    if (isRoot(context)) return this.passCtx;
    let ctx = this.ctxCache.get(context);
    if (ctx === undefined) {
      ctx = this.makeCtx(context);
      this.ctxCache.set(context, ctx);
    }
    return ctx;
  }

  /** Preferred future-dispatch chain for `unit`. */
  futureDispatchChainFor(unit: Function): AssumptionChain {
    return this.chainFor(unit);
  }

  /** Drain to fixed point: analyses → transforms → analyses → CFG rebuild,
   *  iterated until no transform fires and no rebuild occurs. Returns the
   *  units that were rebuilt during this drain (in flush order). Throws if
   *  `limit` rebuilds occur without converging. */
  drain(limit: number = Worklist.DEFAULT_DRAIN_LIMIT): readonly Function[] {
    const changed: Function[] = [];

    while (true) {
      this.processAnalysesToFixpoint();
      const fired = this.sweepTransforms();
      this.processAnalysesToFixpoint();
      const rebuilt = this.units.flushPendingRebuilds();

      if (!fired && rebuilt.length === 0) break;

      for (const unit of rebuilt) changed.push(unit);

      if (changed.length >= limit) {
        throw new Error(
          `[Worklist] drain exceeded ${limit} CFG rebuilds — likely a non-terminating transform cascade.`,
        );
      }
    }

    return changed;
  }

  static readonly DEFAULT_DRAIN_LIMIT = 1000;
}
