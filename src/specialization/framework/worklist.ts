// Priority-scheduled worklist for pass-graph dispatch.

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
import type { Pass, PassCtx, TransformRule, LifecycleEdge } from "./pass";
import { runtimeCallPass, runtimeWritePass } from "./runtime-passes";
import { callCountPass } from "../memoization-analysis/call-count";
import { purityBlockPass, purityScopePass } from "../purity-analysis/analysis";
import { algebraicSimplifyRule } from "../transforms/algebraic-simplify";
import { constantFoldingRule } from "../transforms/constant-folding";
import { deadBranchRule } from "../transforms/dead-branch";
import { memoizationRule } from "../transforms/memoization";
import { typeAnalysisPass, constAnalysisPass } from "./dfa-passes";

type QItem = { pass: Pass<any, any>; key: unknown; seq: number };

const TIER_RANK = { runtime: 0, analysis: 1 } as const;

const compareItems = (a: QItem, b: QItem): number => {
  const ta = TIER_RANK[a.pass.tier];
  const tb = TIER_RANK[b.pass.tier];
  return ta - tb || a.seq - b.seq;
};

export class Worklist {
  private readonly _units: Map<StmtNS.FileInput | StmtNS.FunctionDef, FunctionUnit> = new Map();
  private readonly unitsByFdId: Map<number, FunctionUnit> = new Map();
  private readonly nodeToUnit: Map<number, FunctionUnit> = new Map();
  private readonly nodeToUnits: Map<number, FunctionUnit[]> = new Map();
  private static readonly EMPTY_UNITS: ReadonlyArray<FunctionUnit> = Object.freeze([]);

  /** Units awaiting CFG rebuild after a transform fire. */
  private readonly pendingRebuilds = new Set<FunctionUnit>();

  readonly factStore = new FactStore();
  private readonly registeredPasses: Pass<any, any>[] = [];
  private readonly queue = new PriorityQueue<QItem>(compareItems);
  private seqCounter = 0;
  private readonly pendingKeysByPass = new Map<Pass<any, any>, Set<unknown>>();
  private batchDepth = 0;

  /** Registered transforms and their dirty sets. A unit enters the dirty set
   *  on mint, rebuild, or a write to an upstream pass declared in the rule's
   *  `edges`; sweep clears it. */
  private readonly transforms: TransformRule[] = [];
  private readonly transformDirty = new Map<TransformRule, Set<FunctionUnit>>();

  /** Single fact-change dispatch index. Passes and transforms both compile
   *  their fact edges into callbacks here; no per-subscriber-kind branching
   *  lives in `handleFactChange`. */
  private readonly factSubs = new Map<
    Pass<any, any>,
    Array<(ctx: PassCtx, key: unknown) => void>
  >();
  /** Single lifecycle dispatch index, one list per event kind. Passes'
   *  `LifecycleEdge`s and transforms' mint/rebuild auto-dirtying both
   *  compile into callbacks here. */
  private readonly lifecycleSubs: Record<"mint" | "rebuild" | "retire",
    Array<(ctx: PassCtx, unit: FunctionUnit) => void>
  > = { mint: [], rebuild: [], retire: [] };

  readonly registry: FunctionRegistry;
  private readonly functionEnvironments: FunctionEnvironments;

  get units(): ReadonlyMap<StmtNS.FileInput | StmtNS.FunctionDef, FunctionUnit> {
    return this._units;
  }

  constructor(
    ast: StmtNS.FileInput,
    functionEnvironments: FunctionEnvironments,
    passes: ReadonlyArray<Pass<any, any>> = DEFAULT_PASSES,
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

    for (const p of passes) this.register(p);
    for (const r of transforms) this.registerTransform(r);
    this.factStore.onChange(c => this.handleFactChange(c));

    // Initial units are seeded lazily: `register` replays onUnitMinted to each
    // pass's subscriber, and `registerTransform` populates each rule's dirty
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
    this.fireUnitMinted(unit);
  }

  private onRegistryRetire(fdId: number, node: FunctionScopeNode): void {
    const unit = this.unitsByFdId.get(fdId);
    if (unit === undefined) return;
    this.unitsByFdId.delete(fdId);
    this._units.delete(node as StmtNS.FileInput | StmtNS.FunctionDef);
    this.pendingRebuilds.delete(unit);
    for (const s of this.transformDirty.values()) s.delete(unit);
    // Unit-keyed passes: the blanket evict below drops the cell. Block-keyed
    // DFA passes attach their own `{ on: "retire", effect }` via
    // `makeBlockFixpointPass` and are handled by `fireLifecycle`.
    // TODO: number-keyed passes (runtimeCall/Write, callCount, purityScope)
    // leak cells for retired fdIds — they declare no retire edge, and the
    // blanket evict below silently no-ops against their keyspace.
    for (const p of this.registeredPasses) {
      this.factStore.evict(p, unit);
    }
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

  private fireUnitMinted(unit: FunctionUnit): void {
    this.fireLifecycle("mint", unit);
  }

  private fireUnitRebuilt(unit: FunctionUnit): void {
    this.fireLifecycle("rebuild", unit);
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
    upstream: Pass<any, any>,
    fn: (ctx: PassCtx, key: unknown) => void,
  ): void {
    const list = this.factSubs.get(upstream) ?? [];
    list.push(fn);
    this.factSubs.set(upstream, list);
  }

  /** Register a pass. Idempotent. Compiles each edge in `pass.edges` into a
   *  callback on the unified dispatch indices (`factSubs` / `lifecycleSubs`).
   *  Lifecycle edges with `on: "mint"` fire immediately against every
   *  existing unit so late-registered passes pick up the initial mint burst. */
  register<K, V>(pass: Pass<K, V>): void {
    if (this.registeredPasses.indexOf(pass as Pass<any, any>) !== -1) return;
    this.registeredPasses.push(pass as Pass<any, any>);
    // Stamp the pass so `addEdge` can reject post-registration amendments
    // that would be silently dropped by the dispatch-table snapshot below.
    (pass as Pass<K, V> & { __worklistRegistered?: boolean }).__worklistRegistered = true;
    const reader = pass as Pass<any, any>;
    const fireLifecycleEdge = (lc: LifecycleEdge<any>, unit: FunctionUnit): void => {
      if (lc.wake !== undefined) {
        for (const k of lc.wake(this.passCtx, unit)) this.enqueue(reader, k);
      }
      if (lc.effect !== undefined) lc.effect(this.passCtx, unit);
    };
    for (const spec of pass.edges) {
      if (spec.on !== "fact") {
        // Lifecycle edge: `spec.on` narrows to "mint" | "rebuild" | "retire".
        this.lifecycleSubs[spec.on].push((_ctx, unit) => fireLifecycleEdge(spec, unit));
        continue;
      }
      // Fact edge. `on: "fact"` is mandatory on FactEdge, so narrowing leaves
      // `spec` as FactEdge<K> with no cast required. `wake` is mandatory too.
      const wake = spec.wake;
      this.subscribeFact(spec.pass, (_ctx, key) => {
        for (const k of wake(this.passCtx, key)) this.enqueue(reader, k);
      });
    }
    // Replay existing-unit mints so registration order doesn't determine seeding.
    for (const spec of pass.edges) {
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

    const addUnit = (_ctx: PassCtx, unit: FunctionUnit): void => { dirty.add(unit); };
    this.lifecycleSubs.mint.push(addUnit);
    this.lifecycleSubs.rebuild.push(addUnit);

    if (rule.edges !== undefined) {
      for (const edge of rule.edges) {
        const wake = edge.wake as (ctx: PassCtx, key: unknown) => Iterable<FunctionUnit>;
        this.subscribeFact(edge.pass, (ctx, key) => {
          for (const u of wake(ctx, key)) dirty.add(u);
        });
      }
    }
  }

  observe<K, V>(pass: Pass<K, V>, key: K, value: V): void {
    this.factStore.write(pass, key, value);
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

  enqueue<K, V>(pass: Pass<K, V>, key: K): void {
    const p = pass as Pass<any, any>;
    let pending = this.pendingKeysByPass.get(p);
    if (pending === undefined) {
      pending = new Set();
      this.pendingKeysByPass.set(p, pending);
    }
    if (pending.has(key)) return;
    pending.add(key);
    this.queue.enqueue({ pass: p, key, seq: this.seqCounter++ });
  }

  /** Pop the PQ to empty. Tier order: runtime < analysis. Does not rebuild CFGs. */
  private processQueue(): void {
    while (!this.queue.isEmpty()) {
      const item = this.queue.dequeue()!;
      this.pendingKeysByPass.get(item.pass)?.delete(item.key);
      const value = item.pass.transfer(this.passCtx, item.key);
      if (value !== undefined) {
        this.factStore.write(item.pass, item.key, value);
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
        if (r.sweep(unit, this.passCtx)) {
          this.pendingRebuilds.add(unit);
          anyFired = true;
        }
      }
    }
    return anyFired;
  }

  private readonly passCtx: PassCtx = {
    read: <K2, V2>(p: Pass<K2, V2>, key: K2) => this.factStore.read(p, key),
    tryRead: <K2, V2>(p: Pass<K2, V2>, key: K2) => this.factStore.tryRead(p, key),
    readAll: <K2, V2>(p: Pass<K2, V2>) => this.factStore.readAll(p),
    unitForNode: (nodeId: number) => this.nodeToUnit.get(nodeId),
    unitsContainingNode: (nodeId: number) =>
      this.nodeToUnits.get(nodeId) ?? Worklist.EMPTY_UNITS,
    unitForFdId: (fdId: number) => this.unitsByFdId.get(fdId),
    factStore: this.factStore,
  };

  /** FactStore listener. Invariant: runs inside `FactStore.write`'s
   *  listener-dispatch loop; MUST NOT invoke `factStore.write`. Dispatches
   *  to every subscriber registered against `change.pass` — pass reader
   *  wake-ups and transform dirty-additions compiled into the same list. */
  private handleFactChange(change: FactChange<unknown, unknown>): void {
    const subs = this.factSubs.get(change.pass as Pass<any, any>);
    if (subs === undefined) return;
    for (const sub of subs) sub(this.passCtx, change.key);
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
    for (const unit of rebuilt) this.fireUnitRebuilt(unit);
    return rebuilt;
  }

  private rebuildNodeToUnit(): void {
    this.nodeToUnit.clear();
    this.nodeToUnits.clear();
    for (const unit of this.units.values()) {
      for (const nodeId of unit.blockOfNode.keys()) {
        this.nodeToUnit.set(nodeId, unit);
        const list = this.nodeToUnits.get(nodeId);
        if (list === undefined) this.nodeToUnits.set(nodeId, [unit]);
        else list.push(unit);
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

/** Default production pass set. Tests may pass a subset for isolation. */
export const DEFAULT_PASSES: ReadonlyArray<Pass<any, any>> = [
  runtimeWritePass,
  runtimeCallPass,
  typeAnalysisPass,
  constAnalysisPass,
  purityBlockPass,
  purityScopePass,
  callCountPass,
];

export const DEFAULT_TRANSFORMS: ReadonlyArray<TransformRule> = [
  deadBranchRule,
  constantFoldingRule,
  algebraicSimplifyRule,
  memoizationRule,
];
