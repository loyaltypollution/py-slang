// Priority-scheduled worklist for analysis-graph dispatch.

import { PriorityQueue } from "@datastructures-js/priority-queue";
import { StmtNS } from "../../ast-types";
import type { FunctionEnvironments } from "../../resolver";
import {
  FunctionRegistry,
  buildFunctionRegistry,
  type FunctionScopeNode,
} from "./function-registry";
import type { BasicBlock } from "./cfg";
import { FactStore, type FactChange } from "./fact-store";
import {
  buildFunctionUnits,
  buildOneFunctionUnit,
  wireCFG,
  type FunctionUnit,
} from "./function-unit";
import { REGISTERED_ANALYSES, type Analysis, type AnalysisCtx, type Narrowing, type TransformRule, type LifecycleEdge } from "./analysis";
import { excludeAssumption, extendContext, findAssumption, ROOT_CONTEXT, type Assumption, type Context } from "./context";
import { immediateStrategy, type SpeculationStrategy } from "./speculation-strategy";
import { runtimeCallAnalysis, runtimeWriteAnalysis } from "./runtime-analyses";
import { purityBlockAnalysis, purityScopeAnalysis } from "../purity-analysis/analysis";
import { algebraicSimplifyRule } from "../transforms/algebraic-simplify";
import { constantFoldingRule } from "../transforms/constant-folding";
import { deadBranchRule } from "../transforms/dead-branch";
import { deadStoreRule } from "../transforms/dead-store";
import { memoizationRule } from "../transforms/memoization";
import { livenessAnalysis } from "../liveness-analysis/analysis";
import {
  typeAnalysis,
  constAnalysis,
  DEFAULT_NARROWINGS,
} from "./dfa-analyses";
import { readExprFact } from "./dfa-factory";
import type { RawKind } from "./raw-value";

type QItem = { analysis: Analysis<any, any>; key: unknown; context: Context; seq: number };

/** Reference to a speculative fact site. A backend emitting a guard for
 *  this fact publishes this ref via `Worklist.registerGuard` so the engine
 *  can trace back to the assumption(s) that drove the narrowing when the
 *  guard fires. `narrowing` + `key` together name the fact-store cell (the
 *  narrowing's block analysis, keyed by node id); no value is carried — the
 *  live value is read at deopt time from the fact store.
 *
 *  Typed against `Narrowing<unknown>`: the lineage walk only calls
 *  `narrowing.valueEqual` / `narrowing.blockAnalysis()`, neither of which
 *  needs the specific V. Keeping the interface ungenericized matches actual
 *  usage (every caller erases V to unknown) and removes a cosmetic type
 *  parameter. */
export interface SpecFactRef {
  readonly narrowing: Narrowing<unknown>;
  readonly key: number;
}

/** Narrow backend-facing interface for publishing guard provenance. Exposed
 *  as a separate type so backends can hold a capability-restricted reference
 *  (instead of the full `Worklist`) and so test doubles stay small. */
export interface GuardRegistrar {
  registerGuard(guardNodeId: number, ref: SpecFactRef): void;
}

/** Identity-key for an assumption. `analysis` is compared by symbol identity
 *  (Analyses are module singletons); `key` is compared by the JS `===`
 *  encoding used across the fact store. */
function assumptionKey(a: Assumption): string {
  return `${(a.analysis as Analysis<unknown, unknown>).debugName}:${String(a.key)}`;
}

/** Identity-key for a speculative fact ref — same encoding as
 *  `assumptionKey` so a pruned-assumption set can be checked against
 *  a guard's ref in O(1). */
function specRefKey(r: SpecFactRef): string {
  return `${r.narrowing.handle.debugName}:${String(r.key)}`;
}


const TIER_RANK = { runtime: 0, analysis: 1 } as const;

const compareItems = (a: QItem, b: QItem): number => {
  const ta = TIER_RANK[a.analysis.tier];
  const tb = TIER_RANK[b.analysis.tier];
  return ta - tb || a.seq - b.seq;
};

export class Worklist {
  private readonly _units: Map<StmtNS.FileInput | StmtNS.FunctionDef, FunctionUnit> = new Map();
  private readonly unitsByFdId: Map<number, FunctionUnit> = new Map();
  private readonly nodeToUnit: Map<number, FunctionUnit> = new Map();

  /** Units awaiting CFG rebuild after a transform fire. */
  private readonly pendingRebuilds = new Set<FunctionUnit>();

  readonly factStore = new FactStore();
  private readonly registeredAnalyses: Analysis<any, any>[] = [];
  private readonly queue = new PriorityQueue<QItem>(compareItems);
  private seqCounter = 0;
  /** Dedup guard: a given (analysis, context, key) enqueued twice before being
   *  drained is a single item. Context is part of the dedup identity because
   *  sibling contexts run independent Kildall. */
  private readonly pendingKeysByAnalysis = new Map<
    Analysis<any, any>,
    Map<Context, Set<unknown>>
  >();
  private batchDepth = 0;

  /** Registered transforms and their dirty sets. A unit enters the dirty set
   *  on mint, rebuild, or a write to an upstream analysis declared in the rule's
   *  `edges`; sweep clears it. */
  private readonly transforms: TransformRule[] = [];
  private readonly transformDirty = new Map<TransformRule, Set<FunctionUnit>>();

  /** Per-unit active speculation context. Grows as `runtimeWriteAnalysis`
   *  observations land — each observation adds one assumption per
   *  registered narrowing whose `lift` accepts it (see `this.narrowings`).
   *  `widenWriteObservation` retracts per-observation;
   *  `widenUnitSpeculation` collapses the chain to ROOT on guard violation
   *  (coarser handle, used when the guard's consumer nodeId doesn't match
   *  any observation site — lineage-precise pruning is deferred). Unset or
   *  ROOT_CONTEXT means the unit is currently emitting unspeculated IR.
   *  The tree structure is sibling-capable by construction; sibling
   *  materialization and subtree pruning follow in a later step. */
  private readonly currentSpecContext: Map<FunctionUnit, Context> = new Map();

  /** Single fact-change dispatch index. Analyses and transforms both compile
   *  their fact edges into callbacks here; no per-subscriber-kind branching
   *  lives in `handleFactChange`. */
  private readonly factSubs = new Map<
    Analysis<any, any>,
    Array<(ctx: AnalysisCtx, key: unknown) => void>
  >();
  /** Single lifecycle dispatch index, one list per event kind. Analyses'
   *  `LifecycleEdge`s and transforms' mint/rebuild auto-dirtying both
   *  compile into callbacks here. */
  private readonly lifecycleSubs: Record<"mint" | "rebuild" | "retire" | "specContextChange",
    Array<(ctx: AnalysisCtx, unit: FunctionUnit) => void>
  > = { mint: [], rebuild: [], retire: [], specContextChange: [] };

  readonly registry: FunctionRegistry;
  private readonly functionEnvironments: FunctionEnvironments;

  get units(): ReadonlyMap<StmtNS.FileInput | StmtNS.FunctionDef, FunctionUnit> {
    return this._units;
  }

  /** Policy for when observations should extend the unit's speculation
   *  context. Defaults to `immediateStrategy` — every liftable observation
   *  triggers an extension. Swap in `countBasedStrategy(N)` (or a composed
   *  strategy) to suppress speculation on single outliers. */
  private readonly specStrategy: SpeculationStrategy;

  /** Registered speculation-narrowing dimensions. The observation translator,
   *  widen primitives, and `lineageOf` iterate this list — adding a new
   *  narrowing is a one-line registration here, not a framework edit. */
  private readonly narrowings: ReadonlyArray<Narrowing<any>>;

  constructor(
    ast: StmtNS.FileInput,
    functionEnvironments: FunctionEnvironments,
    analyses: ReadonlyArray<Analysis<any, any>> = DEFAULT_PASSES,
    registry?: FunctionRegistry,
    transforms: ReadonlyArray<TransformRule> = DEFAULT_TRANSFORMS,
    specStrategy: SpeculationStrategy = immediateStrategy,
    narrowings: ReadonlyArray<Narrowing<any>> = DEFAULT_NARROWINGS,
  ) {
    this.specStrategy = specStrategy;
    this.narrowings = narrowings;
    this.registry = registry ?? buildFunctionRegistry(ast);
    this.functionEnvironments = functionEnvironments;
    const built = buildFunctionUnits(ast, functionEnvironments, this.registry);
    for (const [node, unit] of built) {
      this._units.set(node, unit);
      if (unit.funcAst instanceof StmtNS.FunctionDef) {
        this.unitsByFdId.set(unit.funcAst.id, unit);
      }
      if (!this.registry.hasNode(unit.funcAst)) {
        throw new Error(
          `[Worklist] unit for fdId=${unit.funcAst.id} missing from FunctionRegistry — registry likely built from a different AST`,
        );
      }
    }
    this.rebuildNodeToUnit();

    for (const p of analyses) this.register(p);
    for (const r of transforms) this.registerTransform(r);
    this.factStore.onChange(c => this.handleFactChange(c));
    // The observation→context translator hooks directly into `observe`, not
    // via a factStore listener — the fact store short-circuits repeated
    // same-value writes (the monotone fast path), and count-based policies
    // need to see every call, not every lattice change.

    // Initial units are seeded lazily: `register` replays onUnitMinted to each
    // analysis's subscriber, and `registerTransform` populates each rule's dirty
    // set with the existing units. Subsequent mints (mid-drain) fire
    // onUnitMinted via `onRegistryMint`.

    this.registry.setListener({
      onMint: (node, slot) => this.onRegistryMint(node, slot),
      onRetire: (fdId, node) => this.onRegistryRetire(fdId, node),
    });
  }

  private onRegistryMint(node: FunctionScopeNode, _slot: number): void {
    if (!(node instanceof StmtNS.FunctionDef)) return;
    const unit = buildOneFunctionUnit(node, this.functionEnvironments, this.registry);
    this._units.set(node, unit);
    this.unitsByFdId.set(node.id, unit);
    this.rebuildNodeToUnit();
    this.fireLifecycle("mint", unit);
  }

  private onRegistryRetire(fdId: number, node: FunctionScopeNode): void {
    const unit = this.unitsByFdId.get(fdId);
    if (unit === undefined) return;
    this.unitsByFdId.delete(fdId);
    this._units.delete(node as StmtNS.FileInput | StmtNS.FunctionDef);
    this.pendingRebuilds.delete(unit);
    this.currentSpecContext.delete(unit);
    this.guardProvenance.delete(unit);
    this.specStrategy.onUnitRetired?.(unit);
    for (const s of this.transformDirty.values()) s.delete(unit);
    // Each analysis declares its own eviction via `{on:"retire", effect}`.
    this.fireLifecycle("retire", unit);
    this.rebuildNodeToUnit();
  }

  /** Return `rule`'s dirty set, asserting it exists. `registerTransform` is
   *  the only site that populates this map; call sites that touch it outside
   *  that function go through here so the invariant is named. */
  private dirtyFor(rule: TransformRule): Set<FunctionUnit> {
    const s = this.transformDirty.get(rule);
    if (s === undefined) {
      throw new Error(`[Worklist] transform "${rule.debugName}" has no dirty set — missed registerTransform?`);
    }
    return s;
  }

  private fireLifecycle(kind: "mint" | "rebuild" | "retire" | "specContextChange", unit: FunctionUnit): void {
    for (const sub of this.lifecycleSubs[kind]) sub(this.passCtx, unit);
  }

  blockOfNode(nodeId: number): BasicBlock | undefined {
    return this.nodeToUnit.get(nodeId)?.blockOfNode.get(nodeId);
  }

  get nodeIndex(): ReadonlyMap<number, FunctionUnit> {
    return this.nodeToUnit;
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

  /** Register an analysis. Idempotent. Compiles each edge in `analysis.edges` into a
   *  callback on the unified dispatch indices (`factSubs` / `lifecycleSubs`).
   *  Lifecycle edges with `on: "mint"` fire immediately against every
   *  existing unit so late-registered analyses pick up the initial mint burst. */
  register<K, V>(analysis: Analysis<K, V>): void {
    if (this.registeredAnalyses.indexOf(analysis as Analysis<any, any>) !== -1) return;
    this.registeredAnalyses.push(analysis as Analysis<any, any>);
    REGISTERED_ANALYSES.add(analysis as Analysis<any, any>);
    const reader = analysis as Analysis<any, any>;
    const fireLifecycleEdge = (lc: LifecycleEdge<any>, unit: FunctionUnit): void => {
      if (lc.wake !== undefined) {
        for (const k of lc.wake(this.passCtx, unit)) this.enqueue(reader, k);
      }
      if (lc.effect !== undefined) lc.effect(this.factStore, this.passCtx, unit);
    };
    for (const spec of analysis.edges) {
      if (spec.on !== "fact") {
        this.lifecycleSubs[spec.on].push((_ctx, unit) => fireLifecycleEdge(spec, unit));
        continue;
      }
      const wake = spec.wake;
      const effect = spec.effect;
      const toRoot = spec.contextPolicy === "root";
      this.subscribeFact(spec.analysis, (ctx, key) => {
        if (effect !== undefined) effect(this.factStore, ctx, key);
        const enqueueCtx = toRoot ? ROOT_CONTEXT : ctx.currentContext;
        for (const k of wake(ctx, key)) this.enqueue(reader, k, enqueueCtx);
      });
    }
    // Replay existing-unit mints so registration order doesn't determine seeding.
    for (const spec of analysis.edges) {
      if (spec.on !== "mint") continue;
      for (const unit of this._units.values()) fireLifecycleEdge(spec, unit);
    }
  }

  /** Register a transform rule. Idempotent. Existing units seed its dirty
   *  set; mint/rebuild auto-dirty the unit via lifecycle subscriptions; and
   *  each `edge` compiles into a fact subscription that dirties yielded
   *  units. All three paths funnel into the unified dispatch indices —
   *  transforms are not a special subscriber kind. */
  registerTransform(rule: TransformRule): void {
    if (this.transforms.indexOf(rule) !== -1) return;
    this.transforms.push(rule);
    const dirty = new Set<FunctionUnit>();
    for (const u of this._units.values()) dirty.add(u);
    this.transformDirty.set(rule, dirty);

    const addUnit = (_ctx: AnalysisCtx, unit: FunctionUnit): void => { dirty.add(unit); };
    const auto = rule.autoDirtyOn ?? ["mint", "rebuild"];
    for (const kind of auto) this.lifecycleSubs[kind].push(addUnit);

    if (rule.edges !== undefined) {
      for (const edge of rule.edges) {
        const wake = edge.wake;
        this.subscribeFact(edge.analysis, (ctx, key) => {
          for (const u of wake(ctx, key)) dirty.add(u);
        });
      }
    }
  }

  observe<K, V>(analysis: Analysis<K, V>, key: K, value: V, context: Context = ROOT_CONTEXT): void {
    // Analyses that want to run observe-time logic (e.g. extend the unit's
    // speculation context) declare `onObserve`. Fires BEFORE the monotone
    // fact-store write so count-based strategies see every call, including
    // repeats the store would collapse. The worklist has no analysis-
    // identity branches here — participation is a property each analysis
    // declares on itself.
    analysis.onObserve?.(this.observationHost, key, value, context);
    this.factStore.write(analysis, key, value, context);
    if (this.batchDepth === 0) this.processQueue();
  }

  /** Capability surface handed to `Analysis.onObserve` hooks. Narrow
   *  wrapper around the worklist's private observation entry points;
   *  analyses don't receive the full `Worklist`. */
  private readonly observationHost = {
    handleObservationForSpec: (nodeId: number, observed: RawKind): void => {
      this.handleObservationForSpec(nodeId, observed);
    },
  };

  beginBatch(): void {
    this.batchDepth++;
  }

  endBatch(): void {
    if (this.batchDepth === 0) {
      throw new Error("[Worklist] endBatch called without matching beginBatch");
    }
    this.batchDepth--;
    if (this.batchDepth === 0) this.processQueue();
  }

  hasPendingWork(): boolean {
    if (!this.queue.isEmpty() || this.pendingRebuilds.size > 0) return true;
    for (const s of this.transformDirty.values()) if (s.size > 0) return true;
    return false;
  }

  enqueue<K, V>(analysis: Analysis<K, V>, key: K, context: Context = ROOT_CONTEXT): void {
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
    this.queue.enqueue({ analysis: p, key, context, seq: this.seqCounter++ });
  }

  /** Pop the PQ to empty. Tier order: runtime < analysis. Does not rebuild CFGs. */
  private processQueue(): void {
    while (!this.queue.isEmpty()) {
      const item = this.queue.dequeue()!;
      this.pendingKeysByAnalysis.get(item.analysis)?.get(item.context)?.delete(item.key);
      const ctx = this.ctxFor(item.context);
      const value = item.analysis.transfer(this.factStore, ctx, item.key);
      if (value !== undefined) {
        this.factStore.write(item.analysis, item.key, value, item.context);
      }
    }
  }

  /** Sweep every registered transform over its dirty units. Units that
   *  rewrote move to `pendingRebuilds`. Returns true iff any rule fired. */
  private sweepTransforms(): boolean {
    let anyFired = false;
    for (const r of this.transforms) {
      const dirty = this.dirtyFor(r);
      if (dirty.size === 0) continue;
      const units = Array.from(dirty);
      dirty.clear();
      for (const unit of units) {
        if (r.sweep(unit, this.factStore, this.passCtx)) {
          this.pendingRebuilds.add(unit);
          anyFired = true;
        }
      }
    }
    return anyFired;
  }

  private readonly passCtx: AnalysisCtx = {
    unitForNode: (nodeId: number) => this.nodeToUnit.get(nodeId),
    unitForFdId: (fdId: number) => this.unitsByFdId.get(fdId),
    currentContext: ROOT_CONTEXT,
  };

  /** Build an `AnalysisCtx` scoped to `context`. The root context reuses
   *  `passCtx` (hot path); non-root contexts allocate a wrapper sharing the
   *  same unit-topology lookups but swapping `currentContext`. */
  private ctxFor(context: Context): AnalysisCtx {
    if (context === ROOT_CONTEXT) return this.passCtx;
    return {
      unitForNode: this.passCtx.unitForNode,
      unitForFdId: this.passCtx.unitForFdId,
      currentContext: context,
    };
  }

  /** FactStore listener. Invariant: runs inside `FactStore.write`'s
   *  listener-dispatch loop; MUST NOT invoke `factStore.write`. Dispatches
   *  to every subscriber registered against `change.analysis` — analysis reader
   *  wake-ups and transform dirty-additions compiled into the same list.
   *
   *  The `ctx` passed to subscribers carries `change.context` as
   *  `currentContext`, so wake-ups enqueue under the same context the write
   *  originated in — cross-context ripple doesn't happen without an explicit
   *  context-crossing edge. */
  private handleFactChange(change: FactChange<unknown, unknown>): void {
    const subs = this.factSubs.get(change.analysis as Analysis<any, any>);
    if (subs === undefined) return;
    const ctx = this.ctxFor(change.context);
    for (const sub of subs) sub(ctx, change.key);
  }

  /** Re-seed Kildall for every registered narrowing's block analysis at
   *  `unit`'s entry block under `context`. Used whenever the unit's active
   *  speculation context shifts (observation-extend, widen-guard,
   *  widen-unit, lineageOf synthesis). */
  private enqueueNarrowingEntry(unit: FunctionUnit, context: Context): void {
    for (const n of this.narrowings) {
      this.enqueue(n.blockAnalysis(), unit.cfg.entry, context);
    }
  }

  /** Translator: converts `runtimeWriteAnalysis` observations into Context
   *  mutations on the owning unit, then re-seeds Kildall for each
   *  registered narrowing under the new context. An observation binds at
   *  most one assumption per narrowing — all bindings share the same
   *  Context chain so one compiled version depends on one chain (matches
   *  the artifact-tree model in the brief).
   *
   *  Invoked directly from `observe` (not via factStore.onChange) so count-
   *  based strategies see every observed call, including repeats the
   *  monotone fact-store would collapse.
   *
   *  Behavior:
   *  - Non-liftable raws → no-op.
   *  - `unknown` (⊤ widening, e.g. from `widenWriteObservation` on deopt) →
   *    prune any assumption at this nodeId from the unit's current context.
   *    Bypasses the strategy — widening is a correctness retraction, not
   *    a policy choice.
   *  - Concrete lifts → strategy consulted; extensions gated on its verdict.
   *  - Concrete lifts matching existing assumptions → no-op (idempotent).
   *  - New / differing lifts → remove any conflicting assumption at this
   *    nodeId, extend with the new bindings, update `currentSpecContext[unit]`,
   *    enqueue entry block on both analyses. */
  private handleObservationForSpec(nodeId: number, observed: RawKind): void {
    const unit = this.nodeToUnit.get(nodeId);
    if (unit === undefined) return;

    const parentCtx = this.currentSpecContext.get(unit) ?? ROOT_CONTEXT;

    if (observed.kind !== "unknown") {
      const accept = this.specStrategy.onObservation({
        unit,
        nodeId,
        observed,
        parentContext: parentCtx,
      });
      if (!accept) return;
    }

    if (observed.kind === "unknown") {
      let pruned = parentCtx;
      for (const n of this.narrowings) {
        pruned = excludeAssumption(pruned, n.handle, nodeId);
      }
      if (pruned === parentCtx) return;
      if (pruned === ROOT_CONTEXT) this.currentSpecContext.delete(unit);
      else this.currentSpecContext.set(unit, pruned);
      this.enqueueNarrowingEntry(unit, pruned);
      this.fireLifecycle("specContextChange", unit);
      return;
    }

    let newCtx = parentCtx;
    for (const n of this.narrowings) {
      const lifted = n.lift(observed);
      if (lifted === undefined) continue;
      const existing = findAssumption(newCtx, n.handle, nodeId);
      if (existing !== undefined && n.valueEqual(existing, lifted)) continue;
      const cleaned = existing !== undefined
        ? excludeAssumption(newCtx, n.handle, nodeId)
        : newCtx;
      newCtx = extendContext(cleaned, n.handle, nodeId, lifted);
    }

    if (newCtx === parentCtx) return;
    this.currentSpecContext.set(unit, newCtx);
    this.enqueueNarrowingEntry(unit, newCtx);
    this.fireLifecycle("specContextChange", unit);
  }

  /** Active speculation context for a unit. Readers of `typeAnalysis`
   *  looking for speculatively-narrowed facts should pass this context to
   *  `readExprFact` / `factStore.tryRead`. */
  specContextFor(unit: FunctionUnit): Context {
    return this.currentSpecContext.get(unit) ?? ROOT_CONTEXT;
  }

  /** Same as `specContextFor`, keyed by nodeId. Convenience for consumers
   *  that only have an AST node id (e.g. the DfaQuery projection). */
  specContextForNode(nodeId: number): Context {
    const unit = this.nodeToUnit.get(nodeId);
    return unit === undefined ? ROOT_CONTEXT : this.specContextFor(unit);
  }

  /** Retract ALL speculation for the unit owning `nodeIdOrUnit`. Private
   *  soundness fallback invoked by `widenGuard` when (a) no provenance was
   *  registered for the guard's nodeId (backend hasn't opted into
   *  `registerGuard`) or (b) `lineageOf` returned empty because trial-
   *  exclusion couldn't find a single load-bearing link (joint narrowing).
   *  Both cases require the coarser whole-chain reset to stay sound.
   *
   *  Collapsing the chain to ROOT: Kildall re-runs under ROOT produce the
   *  non-narrowed facts, the `specContextChange` lifecycle fires, and jit-
   *  keyed analyses re-seed themselves on the next drain. Returns the unit
   *  that was widened, or `undefined` if no unit owns the node or the unit
   *  already has no active speculation. */
  private widenUnitSpeculation(nodeIdOrUnit: number | FunctionUnit): FunctionUnit | undefined {
    const unit = typeof nodeIdOrUnit === "number"
      ? this.nodeToUnit.get(nodeIdOrUnit)
      : nodeIdOrUnit;
    if (unit === undefined) return undefined;
    if (!this.currentSpecContext.has(unit)) return undefined;
    this.currentSpecContext.delete(unit);
    this.guardProvenance.get(unit)?.clear();
    this.enqueueNarrowingEntry(unit, ROOT_CONTEXT);
    this.fireLifecycle("specContextChange", unit);
    return unit;
  }

  /** Per-unit, per-guard-site record of which speculative fact the guard
   *  protects. Populated by backends via `registerGuard`; consumed by
   *  `widenGuard` on deopt to compute the load-bearing assumption set. Keyed
   *  by `guardNodeId` — the AST node id the backend baked into the guard
   *  opcode; that's the id `SpeculationViolation` carries. */
  private readonly guardProvenance: Map<FunctionUnit, Map<number, SpecFactRef>> = new Map();

  /** Backend-facing hook, called once per emitted guard. Identifies the
   *  speculative fact whose narrowing the guard is protecting. No-op if
   *  `guardNodeId` doesn't resolve to a known unit. */
  registerGuard(guardNodeId: number, ref: SpecFactRef): void {
    const unit = this.nodeToUnit.get(guardNodeId);
    if (unit === undefined) return;
    let perUnit = this.guardProvenance.get(unit);
    if (perUnit === undefined) {
      perUnit = new Map();
      this.guardProvenance.set(unit, perUnit);
    }
    perUnit.set(guardNodeId, ref);
  }

  /** Lineage-precise deopt handle. Given a guard that fired at
   *  `guardNodeId`, prune just the assumption(s) in the owning unit's spec
   *  chain whose removal would widen the speculative fact at `ref`. Sibling
   *  assumptions (load-bearing for OTHER guards in the same unit) survive.
   *
   *  Falls back to `widenUnitSpeculation` when no provenance was recorded
   *  for `guardNodeId` (safe default for backends that haven't opted in)
   *  or when the computed lineage is empty (can happen if the fact at `ref`
   *  reached its narrowed value via chain links whose handle doesn't match
   *  `ref.narrowing.handle` — a conservative signal to fall back).
   *
   *  Returns the widened unit, or `undefined` if no unit owns `guardNodeId`. */
  widenGuard(guardNodeId: number): FunctionUnit | undefined {
    const unit = this.nodeToUnit.get(guardNodeId);
    if (unit === undefined) return undefined;
    const ref = this.guardProvenance.get(unit)?.get(guardNodeId);
    if (ref === undefined) return this.widenUnitSpeculation(unit);

    const ctx = this.currentSpecContext.get(unit);
    if (ctx === undefined || ctx === ROOT_CONTEXT) return undefined;

    const loadBearing = this.lineageOf(ref, ctx, unit);
    if (loadBearing.length === 0) return this.widenUnitSpeculation(unit);

    let pruned: Context = ctx;
    for (const a of loadBearing) {
      pruned = excludeAssumption(pruned, a.analysis, a.key);
    }
    if (pruned === ctx) return undefined;

    if (pruned === ROOT_CONTEXT) this.currentSpecContext.delete(unit);
    else this.currentSpecContext.set(unit, pruned);
    // Drop provenance whose guard was protecting a pruned assumption. A
    // surviving guard may have listed a non-pruned assumption among its
    // load-bearing set; clearing *all* provenance for the unit would be
    // safe but throws away reusable entries. Trim precisely.
    const perUnit = this.guardProvenance.get(unit);
    if (perUnit !== undefined) {
      const prunedSet = new Set(loadBearing.map(a => assumptionKey(a)));
      for (const [gid, r] of perUnit) {
        if (prunedSet.has(specRefKey(r))) perUnit.delete(gid);
      }
    }
    this.enqueueNarrowingEntry(unit, pruned);
    this.fireLifecycle("specContextChange", unit);
    return unit;
  }

  /** Identify assumptions in `ctx`'s chain whose removal widens the fact at
   *  `(ref.analysis, ref.key)`. Algorithm: for each link, synthesize the
   *  chain without it, re-seed Kildall for every registered narrowing
   *  under the synthesized chain (no transforms, no CFG rebuild), and diff
   *  the fact at `ref`. Cells under the synthetic chain are written to the
   *  fact store and linger — contexts are identity-keyed so no collision,
   *  but a fact-store eviction pass is a later step (C5b follow-up).
   *
   *  Cost: O(chainDepth × Kildall-at-pruned-ctx). Chain depth is bounded by
   *  the speculation strategy (`countBasedStrategy`, etc.) which throttles
   *  extension; deep chains are the outlier case. */
  private lineageOf(
    ref: SpecFactRef,
    ctx: Context,
    unit: FunctionUnit,
  ): Assumption[] {
    const { narrowing, key: nodeId } = ref;
    const blockAnalysis = narrowing.blockAnalysis();
    const block = unit.blockOfNode.get(nodeId);
    if (block === undefined) return [];
    const current = readExprFact(this.factStore, blockAnalysis, block, nodeId, ctx);
    const loadBearing: Assumption[] = [];
    for (let cur: Context | undefined = ctx; cur !== undefined; cur = cur.parent) {
      const a = cur.assumption;
      if (a === undefined) continue;
      const without = excludeAssumption(ctx, a.analysis, a.key);
      if (without === ctx) continue;
      this.enqueueNarrowingEntry(unit, without);
      this.processQueue();
      const widened = readExprFact(this.factStore, blockAnalysis, block, nodeId, without);
      if (!narrowing.valueEqual(current, widened)) loadBearing.push(a);
    }
    return loadBearing;
  }

  /** Rebuild CFG for every pending unit, then fire `onUnitRebuilt`. */
  private flushPendingRebuilds(): FunctionUnit[] {
    if (this.pendingRebuilds.size === 0) return [];
    const rebuilt: FunctionUnit[] = [];
    for (const unit of this.pendingRebuilds) {
      unit.generation++;
      wireCFG(unit);
      // A CFG rebuild invalidates every guard's nodeId: the old ids belong
      // to AST subtrees that the backend hasn't seen yet. The next compile
      // will re-register guards with ids valid under the new generation.
      this.guardProvenance.delete(unit);
      rebuilt.push(unit);
    }
    this.pendingRebuilds.clear();
    this.rebuildNodeToUnit();
    for (const unit of rebuilt) this.fireLifecycle("rebuild", unit);
    return rebuilt;
  }

  private rebuildNodeToUnit(): void {
    this.nodeToUnit.clear();
    for (const unit of this.units.values()) {
      for (const nodeId of unit.blockOfNode.keys()) {
        this.nodeToUnit.set(nodeId, unit);
      }
    }
  }

  /** Drain to fixed point. Each iteration:
   *   1. `processQueue` — analyses / observations converge.
   *   2. `sweepTransforms` — imperative AST rewrites on dirty units.
   *   3. `processQueue` — pick up any writes made by transforms (rare, but
   *      transforms may read fact-store state that needs to be settled
   *      before rebuild for the next iteration's analyses).
   *   4. `flushPendingRebuilds` — rewire CFGs for units that fired; fires
   *      `onUnitRebuilt`, which re-enqueues analyses and re-marks transforms
   *      dirty.
   *  Terminates when no transform fired and no rebuild occurred. */
  drain(limit: number = Worklist.DEFAULT_DRAIN_LIMIT): ReadonlySet<StmtNS.FileInput | StmtNS.FunctionDef> {
    const changed = new Set<StmtNS.FileInput | StmtNS.FunctionDef>();
    let processed = 0;

    while (true) {
      this.processQueue();
      const fired = this.sweepTransforms();
      this.processQueue();
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

/** Default production analysis set. Tests may use a subset for isolation. */
export const DEFAULT_PASSES: ReadonlyArray<Analysis<any, any>> = [
  runtimeWriteAnalysis,
  runtimeCallAnalysis,
  typeAnalysis,
  constAnalysis,
  purityBlockAnalysis,
  purityScopeAnalysis,
  livenessAnalysis,
];

export const DEFAULT_TRANSFORMS: ReadonlyArray<TransformRule> = [
  deadBranchRule,
  constantFoldingRule,
  algebraicSimplifyRule,
  deadStoreRule,
  memoizationRule,
];
