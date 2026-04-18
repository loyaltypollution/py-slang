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
import { REGISTERED_ANALYSES, type Analysis, type AnalysisCtx, type TransformRule, type LifecycleEdge } from "./analysis";
import { ROOT_CONTEXT, type Context } from "./context";
import { runtimeCallAnalysis, runtimeWriteAnalysis, speculationBlacklistAnalysis } from "./runtime-analyses";
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
  speculativeTypeAnalysis,
  speculativeConstAnalysis,
} from "./dfa-analyses";
import { readExprFact } from "./dfa-factory";
import type { TypeLattice } from "../type-analysis/lattice";
import type { ConstLattice } from "../const-analysis/lattice";

/** Per-node read-only projection of the DFA fact-store. Resolves the
 *  containing BasicBlock internally via `nodeIndex`, so callers identify
 *  nodes by id alone. */
export interface DfaQuery {
  typeOf(nodeId: number): TypeLattice | undefined;
  constOf(nodeId: number): ConstLattice | undefined;
  /** Speculatively-narrowed type fact (observation `meet`'d with static).
   *  Consumers MUST emit a runtime guard at any specialization decision
   *  that depends on a tighter answer than `typeOf` would give. */
  speculativeTypeOf(nodeId: number): TypeLattice | undefined;
  speculativeConstOf(nodeId: number): ConstLattice | undefined;
  /** Purity verdict for a FunctionDef scope. `true` = no observable side
   *  effects ⇒ safe to whole-call deopt re-entry. `false` = impure.
   *  `undefined` = not yet computed (treat as impure for safety). */
  isPureScope(scopeId: number): boolean | undefined;
  /** True iff a prior guard at this nodeId fired and the deopt handler
   *  blacklisted further speculation. The compiler must use the generic
   *  opcode at this site even if speculative facts still appear narrowed. */
  isSpeculationBlacklisted(nodeId: number): boolean;
}

export function makeDfaQuery(
  factStore: FactStore,
  nodeIndex: ReadonlyMap<number, FunctionUnit>,
): DfaQuery {
  const blockFor = (id: number) => nodeIndex.get(id)?.blockOfNode.get(id);
  return {
    typeOf: id => readExprFact(factStore, typeAnalysis, blockFor(id), id),
    constOf: id => readExprFact(factStore, constAnalysis, blockFor(id), id),
    speculativeTypeOf: id => readExprFact(factStore, speculativeTypeAnalysis, blockFor(id), id),
    speculativeConstOf: id => readExprFact(factStore, speculativeConstAnalysis, blockFor(id), id),
    isPureScope: scopeId => factStore.tryRead(purityScopeAnalysis, scopeId),
    isSpeculationBlacklisted: nodeId =>
      factStore.tryRead(speculationBlacklistAnalysis, nodeId) === true,
  };
}

type QItem = { analysis: Analysis<any, any>; key: unknown; context: Context; seq: number };

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
  private readonly lifecycleSubs: Record<"mint" | "rebuild" | "retire",
    Array<(ctx: AnalysisCtx, unit: FunctionUnit) => void>
  > = { mint: [], rebuild: [], retire: [] };

  readonly registry: FunctionRegistry;
  private readonly functionEnvironments: FunctionEnvironments;

  get units(): ReadonlyMap<StmtNS.FileInput | StmtNS.FunctionDef, FunctionUnit> {
    return this._units;
  }

  constructor(
    ast: StmtNS.FileInput,
    functionEnvironments: FunctionEnvironments,
    analyses: ReadonlyArray<Analysis<any, any>> = DEFAULT_PASSES,
    registry?: FunctionRegistry,
    transforms: ReadonlyArray<TransformRule> = DEFAULT_TRANSFORMS,
  ) {
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

  private fireLifecycle(kind: "mint" | "rebuild" | "retire", unit: FunctionUnit): void {
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
      this.subscribeFact(spec.analysis, (ctx, key) => {
        if (effect !== undefined) effect(this.factStore, ctx, key);
        for (const k of wake(ctx, key)) this.enqueue(reader, k, ctx.currentContext);
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
    this.factStore.write(analysis, key, value, context);
    if (this.batchDepth === 0) this.processQueue();
  }

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

  /** Rebuild CFG for every pending unit, then fire `onUnitRebuilt`. */
  private flushPendingRebuilds(): FunctionUnit[] {
    if (this.pendingRebuilds.size === 0) return [];
    const rebuilt: FunctionUnit[] = [];
    for (const unit of this.pendingRebuilds) {
      unit.generation++;
      wireCFG(unit);
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
  speculationBlacklistAnalysis,
  typeAnalysis,
  constAnalysis,
  speculativeTypeAnalysis,
  speculativeConstAnalysis,
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
