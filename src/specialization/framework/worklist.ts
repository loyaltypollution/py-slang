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
import type { Pass, PassCtx } from "./pass";
import { structuralPass } from "./structural-pass";
import { runtimeCallPass, runtimeWritePass } from "./runtime-passes";
import { callCountPass } from "../memoization-analysis/call-count";
import { purityBlockPass, purityScopePass } from "../purity-analysis/analysis";
import { constantFoldingRule } from "../transforms/constant-folding";
import { deadBranchRule } from "../transforms/dead-branch";
import { memoizationRule } from "../transforms/memoization";
import { typeAnalysisPass, constAnalysisPass } from "./dfa-passes";

type QItem = { pass: Pass<any, any>; key: unknown; seq: number };

const TIER_RANK = { runtime: 0, analysis: 1, transform: 2 } as const;

const compareItems = (a: QItem, b: QItem): number => {
  const ta = TIER_RANK[a.pass.tier ?? "analysis"];
  const tb = TIER_RANK[b.pass.tier ?? "analysis"];
  return ta - tb || a.seq - b.seq;
};

export class Worklist {
  /** Mutated on mint/retire; exposed read-only via `units`. */
  private readonly _units: Map<StmtNS.FileInput | StmtNS.FunctionDef, FunctionUnit> = new Map();
  /** funcAst.id → owning unit. */
  private readonly unitsByFdId: Map<number, FunctionUnit> = new Map();
  /** nodeId → innermost containing unit. */
  private readonly nodeToUnit: Map<number, FunctionUnit> = new Map();
  /** nodeId → every containing unit. */
  private readonly nodeToUnits: Map<number, FunctionUnit[]> = new Map();
  private static readonly EMPTY_UNITS: ReadonlyArray<FunctionUnit> = Object.freeze([]);

  /** Units awaiting CFG rebuild after a transform fire. */
  private readonly pendingRebuilds = new Set<FunctionUnit>();

  readonly factStore = new FactStore();
  private readonly registeredPasses: Pass<any, any>[] = [];
  private readonly passReaders = new Map<Pass<any, any>, Pass<any, any>[]>();
  /** reader → (upstream pass → wake fn). One entry per edge that declares a
   *  `wake` function. */
  private readonly passWakers = new Map<
    Pass<any, any>,
    Map<Pass<any, any>, (ctx: PassCtx, key: unknown) => Iterable<unknown>>
  >();
  /** reader → (upstream pass → evict fn). One entry per edge that declares
   *  an `evict` function. */
  private readonly passEvictors = new Map<
    Pass<any, any>,
    Map<Pass<any, any>, (ctx: PassCtx, key: unknown) => Iterable<unknown>>
  >();
  /** Global priority queue: tier rank (runtime < analysis < transform), FIFO within tier. */
  private readonly queue = new PriorityQueue<QItem>(compareItems);
  private seqCounter = 0;
  /** Dedup — at most one pending entry per (pass, key). */
  private readonly pendingKeysByPass = new Map<Pass<any, any>, Set<unknown>>();
  /** Re-entrant batch depth. While >0, `observe` skips `processQueue`. */
  private batchDepth = 0;
  /** Evictions queued from inside listener dispatch. Drained at the top of
   *  `processQueue`, outside any `FactStore.write` frame. Keeps listeners
   *  strictly read-only w.r.t. the fact store even though `evict` itself is
   *  event-free — future evict implementations that emit events won't silently
   *  break the no-reentry contract. */
  private readonly pendingEvictions: Array<[Pass<any, any>, unknown]> = [];

  readonly registry: FunctionRegistry;
  private readonly functionEnvironments: FunctionEnvironments;

  /** Read-only view of scope-node → unit. Internally mutable via on-mint /
   *  on-retire handlers; external consumers must not depend on identity of
   *  the underlying map. */
  get units(): ReadonlyMap<StmtNS.FileInput | StmtNS.FunctionDef, FunctionUnit> {
    return this._units;
  }

  /**
   * @param registry  Optional shared identity source. Pass when a downstream
   *   compiler must observe the same slot assignment (JIT pipelines). Omit to
   *   build one internally from `ast`. When supplied externally, it MUST have
   *   been built from the same `ast` — the registered-node assertion below
   *   is the only guard against a mismatched pair.
   */
  constructor(
    ast: StmtNS.FileInput,
    functionEnvironments: FunctionEnvironments,
    passes: ReadonlyArray<Pass<any, any>> = DEFAULT_PASSES,
    registry?: FunctionRegistry,
  ) {
    this.registry = registry ?? buildFunctionRegistry(ast);
    this.functionEnvironments = functionEnvironments;
    const built = buildFunctionUnits(ast, functionEnvironments, this.registry);
    for (const [node, unit] of built) {
      this._units.set(node, unit);
      if (unit.funcAst instanceof StmtNS.FunctionDef) {
        this.unitsByFdId.set(unit.funcAst.id, unit);
      }
      // Guards against a caller-supplied registry built from a different AST.
      // Dead in the internal-fallback path — `buildFunctionRegistry` mints
      // every scope by construction.
      if (!this.registry.hasNode(unit.funcAst)) {
        throw new Error(
          `[Worklist] unit for fdId=${unit.funcAst.id} missing from FunctionRegistry — registry likely built from a different AST`,
        );
      }
    }
    this.rebuildNodeToUnit();

    for (const p of passes) this.register(p);
    this.factStore.onChange(c => this.handleFactChange(c));
    this.factStore.onPostDispatch(() => this.drainPendingEvictions());

    // Seed structuralPass for every unit to wake downstream passes.
    for (const unit of this._units.values()) {
      this.factStore.write(structuralPass, unit, 0);
    }

    // Subscribe to mint/retire AFTER initial construction so the build-pass
    // mints that already happened don't re-enter handlers.
    this.registry.setListener({
      onMint: (node, slot) => this.onRegistryMint(node, slot),
      onRetire: (fdId, node) => this.onRegistryRetire(fdId, node),
    });
  }

  /** Bump structuralPass for the unit owning `fdId` and schedule its CFG
   *  to be rebuilt on next drain. Callers that mint/retire a nested function
   *  MUST invoke this for the enclosing unit — the registry listener wakes
   *  the new/removed unit, but not the enclosing scope whose body changed. */
  markStructuralChange(fdId: number): void {
    const unit = this.unitsByFdId.get(fdId);
    if (unit === undefined) {
      throw new Error(`[Worklist] markStructuralChange: no unit for fdId=${fdId}`);
    }
    this.pendingRebuilds.add(unit);
    const cur = this.factStore.read(structuralPass, unit);
    this.factStore.write(structuralPass, unit, cur + 1);
  }

  /** Registry listener: a new function scope was minted. Lambda / MultiLambda
   *  do not have FunctionUnits in this codebase, so we only materialize a unit
   *  for FunctionDef. The caller remains responsible for also calling
   *  `markStructuralChange(enclosingFdId)` to rebuild the enclosing body. */
  private onRegistryMint(node: FunctionScopeNode, _slot: number): void {
    if (!(node instanceof StmtNS.FunctionDef)) return;
    const unit = buildOneFunctionUnit(node, this.functionEnvironments, this.registry);
    this._units.set(node, unit);
    this.unitsByFdId.set(node.id, unit);
    this.rebuildNodeToUnit();
    this.factStore.write(structuralPass, unit, 0);
  }

  /** Registry listener: a function scope was retired. Drop its unit and
   *  evict every fact keyed on it. Enclosing-unit bookkeeping is the
   *  caller's responsibility (`markStructuralChange`). */
  private onRegistryRetire(fdId: number, node: FunctionScopeNode): void {
    const unit = this.unitsByFdId.get(fdId);
    if (unit === undefined) return; // Lambda/MultiLambda or already gone.
    this.unitsByFdId.delete(fdId);
    this._units.delete(node as StmtNS.FileInput | StmtNS.FunctionDef);
    this.pendingRebuilds.delete(unit);
    // Evict unit-keyed facts so stale lookups return undefined rather than lie.
    // structuralPass is seeded unconditionally in the constructor, so evict it
    // explicitly — it may not be in registeredPasses if the caller passed a
    // pass subset.
    this.factStore.evict(structuralPass, unit);
    for (const p of this.registeredPasses) {
      this.factStore.evict(p, unit);
    }
    this.rebuildNodeToUnit();
  }

  /** nodeId → innermost containing unit's BasicBlock for that node. */
  blockOfNode(nodeId: number): BasicBlock | undefined {
    return this.nodeToUnit.get(nodeId)?.blockOfNode.get(nodeId);
  }

  /** Read-only view of the nodeId → innermost-unit index. Exposed so
   *  out-of-framework consumers (e.g. SVMLCompiler) can resolve per-node
   *  DFA facts via `readExprFact` without each re-scanning `units`. */
  get nodeIndex(): ReadonlyMap<number, FunctionUnit> {
    return this.nodeToUnit;
  }

  /** Register a pass. Idempotent. On an upstream write, each edge matching
   *  the written pass runs its `wake` (→ enqueue) and `evict` (→ delete from
   *  fact store) projections; edges with neither are dependency-only. */
  register<K, V>(pass: Pass<K, V>): void {
    if (this.registeredPasses.indexOf(pass as Pass<any, any>) !== -1) return;
    this.registeredPasses.push(pass as Pass<any, any>);
    const reader = pass as Pass<any, any>;
    const wakeMap: Map<
      Pass<any, any>,
      (ctx: PassCtx, key: unknown) => Iterable<unknown>
    > = new Map();
    this.passWakers.set(reader, wakeMap);
    let evictMap:
      | Map<Pass<any, any>, (ctx: PassCtx, key: unknown) => Iterable<unknown>>
      | undefined;
    for (const spec of pass.edges) {
      const upstream = spec.pass;
      const list = this.passReaders.get(upstream) ?? [];
      list.push(reader);
      this.passReaders.set(upstream, list);
      if (spec.wake !== undefined) {
        wakeMap.set(upstream, spec.wake as (ctx: PassCtx, key: unknown) => Iterable<unknown>);
      }
      if (spec.evict !== undefined) {
        if (evictMap === undefined) {
          evictMap = new Map();
          this.passEvictors.set(reader, evictMap);
        }
        evictMap.set(upstream, spec.evict as (ctx: PassCtx, key: unknown) => Iterable<unknown>);
      }
    }
  }

  /** Runtime-observation entry: write and process queue synchronously. While a
   *  batch is open (`beginBatch`/`endBatch`), the drain is deferred to the
   *  outermost `endBatch`. Monotone lattices reach the same fixed point either
   *  way — this only suppresses per-write fan-out churn. */
  observe<K, V>(pass: Pass<K, V>, key: K, value: V): void {
    this.factStore.write(pass, key, value);
    if (this.batchDepth === 0) this.processQueue();
  }

  /** Open a batch. Re-entrant: nested begin/endBatch pairs compose via a counter;
   *  only the outermost `endBatch` drains. */
  beginBatch(): void {
    this.batchDepth++;
  }

  /** Close a batch. Drains the queue iff this closes the outermost batch.
   *  Throws if called without a matching `beginBatch`. */
  endBatch(): void {
    if (this.batchDepth === 0) {
      throw new Error("[Worklist] endBatch called without matching beginBatch");
    }
    this.batchDepth--;
    if (this.batchDepth === 0) this.processQueue();
  }

  /** True iff a subsequent `drain()` would do any work. O(1). */
  hasPendingWork(): boolean {
    return !this.queue.isEmpty() || this.pendingRebuilds.size > 0;
  }

  /** Enqueue `(pass, key)` for re-transfer. Deduped per pair. */
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

  /** Pop the PQ to empty. Tier order: runtime < analysis < transform. Does not rebuild CFGs. */
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

  private drainPendingEvictions(): void {
    if (this.pendingEvictions.length === 0) return;
    const batch = this.pendingEvictions.splice(0);
    for (const [p, k] of batch) this.factStore.evict(p, k);
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

  /** FactStore listener. Invariant: this runs inside `FactStore.write`'s
   *  listener-dispatch loop, so it (and anything it calls) MUST NOT invoke
   *  `factStore.write` — re-entrant writes would let listener fan-out observe
   *  mid-iteration state and break the "one event per value-changing write"
   *  contract that single-call consumers (e.g. jit-pass's `analysisGen` bump)
   *  rely on. Evictions needed by prune are queued into
   *  `pendingEvictions` and drained at the top of `processQueue`, keeping
   *  listeners strictly read-only w.r.t. the fact store. New writes triggered
   *  by a change belong in `enqueue` → `processQueue`, not in this handler.
   *  `FactStore.write` throws on re-entry to enforce this. */
  private handleFactChange(change: FactChange<unknown, unknown>): void {
    const readers = this.passReaders.get(change.pass as Pass<any, any>);
    // Defer CFG rebuild until the current drain completes.
    if (
      change.pass.tier === "transform" &&
      change.newValue === "fired" &&
      change.oldValue !== "fired"
    ) {
      this.pendingRebuilds.add(change.key as FunctionUnit);
    }
    if (readers === undefined || readers.length === 0) return;
    for (const reader of readers) {
      const keys = this.computeAffectedKeys(reader, change);
      for (const k of keys) this.enqueue(reader, k);
      const evictFn = this.passEvictors.get(reader)?.get(change.pass as Pass<any, any>);
      if (evictFn !== undefined) {
        for (const k of evictFn(this.passCtx, change.key)) {
          this.pendingEvictions.push([reader, k]);
        }
      }
    }
  }

  /** Rebuild CFG + bump structuralPass for every pending unit. */
  private flushPendingRebuilds(): FunctionUnit[] {
    if (this.pendingRebuilds.size === 0) return [];
    const rebuilt: FunctionUnit[] = [];
    for (const unit of this.pendingRebuilds) {
      unit.generation++;
      wireCFG(unit);
      const cur = this.factStore.read(structuralPass, unit);
      this.factStore.write(structuralPass, unit, cur + 1);
      rebuilt.push(unit);
    }
    this.pendingRebuilds.clear();
    this.rebuildNodeToUnit();
    return rebuilt;
  }

  /** Rebuild nodeId → unit indexes. Innermost-containing unit wins for the
   *  `nodeToUnit` lookup: unit iteration runs outer → inner (FileInput first,
   *  then nested FunctionDefs), so last-write-wins picks the innermost. */
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

  private computeAffectedKeys(
    reader: Pass<any, any>,
    change: FactChange<unknown, unknown>,
  ): Iterable<unknown> {
    const wake = this.passWakers.get(reader)?.get(change.pass as Pass<any, any>);
    return wake === undefined ? [] : wake(this.passCtx, change.key);
  }

  /** Drain to fixed point. `limit` caps the number of CFG rebuild iterations —
   *  a safety valve against cascading transforms that fail to converge (e.g.
   *  a buggy transform whose `firedLattice` gate never trips). Under the stated
   *  termination argument (AST-size potential + one-shot memoization), the bound
   *  is O(initialAstSize + functionCount); the default is a generous multiple.
   *  Exceeding the limit throws. */
  drain(limit: number = Worklist.DEFAULT_DRAIN_LIMIT): ReadonlySet<StmtNS.FileInput | StmtNS.FunctionDef> {
    const changed = new Set<StmtNS.FileInput | StmtNS.FunctionDef>();
    let processed = 0;

    while (true) {
      this.processQueue();
      const rebuilt = this.flushPendingRebuilds();

      if (rebuilt.length === 0) break;

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
  structuralPass,
  runtimeWritePass,
  runtimeCallPass,
  typeAnalysisPass,
  constAnalysisPass,
  purityBlockPass,
  purityScopePass,
  callCountPass,
  deadBranchRule,
  constantFoldingRule,
  memoizationRule,
];

