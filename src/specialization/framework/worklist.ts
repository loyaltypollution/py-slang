// Priority-scheduled worklist for pass-graph dispatch.

import { PriorityQueue } from "@datastructures-js/priority-queue";
import { StmtNS } from "../../ast-types";
import type { FunctionEnvironments } from "../../resolver";
import type { BasicBlock } from "./cfg";
import { buildCFG } from "./cfg";
import { FactStore, type FactChange } from "./fact-store";
import { buildFunctionUnits, indexCFG, type FunctionUnit } from "./function-unit";
import type { Pass, PassCtx } from "./pass";
import { structuralPass } from "./structural-pass";
import { runtimeCallPass, runtimeWritePass } from "./runtime-passes";
import { constAnalysisPass } from "../const-analysis/analysis";
import { callCountPass } from "../memoization-analysis/call-count";
import { purityScopePass } from "../purity-analysis/analysis";
import { constantFoldingRule } from "../transforms/constant-folding";
import { deadBranchRule } from "../transforms/dead-branch";
import { memoizationRule } from "../transforms/memoization";
import { typeAnalysisPass } from "../type-analysis/analysis";
import { typeAnalysisDfa, constAnalysisDfa } from "./dfa-passes";

type QItem = { pass: Pass<any, any>; key: unknown; seq: number };

const TIER_RANK = { runtime: 0, analysis: 1, transform: 2 } as const;

const compareItems = (a: QItem, b: QItem): number => {
  const ta = TIER_RANK[a.pass.tier ?? "analysis"];
  const tb = TIER_RANK[b.pass.tier ?? "analysis"];
  return ta - tb || a.seq - b.seq;
};

export class Worklist {
  readonly units: ReadonlyMap<StmtNS.FileInput | StmtNS.FunctionDef, FunctionUnit>;
  /** funcAst.id → owning unit. */
  private readonly unitsByFdId: Map<number, FunctionUnit> = new Map();
  /** nodeId → outermost containing unit. */
  private readonly nodeToUnit: Map<number, FunctionUnit> = new Map();
  /** nodeId → every containing unit. */
  private readonly nodeToUnits: Map<number, FunctionUnit[]> = new Map();
  private static readonly EMPTY_UNITS: ReadonlyArray<FunctionUnit> = Object.freeze([]);

  /** Units awaiting CFG rebuild after a transform fire. */
  private readonly pendingRebuilds = new Set<FunctionUnit>();

  readonly factStore = new FactStore();
  private readonly registeredPasses: Pass<any, any>[] = [];
  private readonly passReaders = new Map<Pass<any, any>, Pass<any, any>[]>();
  /** Global priority queue: tier rank (runtime < analysis < transform), FIFO within tier. */
  private readonly queue = new PriorityQueue<QItem>(compareItems);
  private seqCounter = 0;
  /** Dedup — at most one pending entry per (pass, key). */
  private readonly pendingKeysByPass = new Map<Pass<any, any>, Set<unknown>>();
  /** Re-entrant batch depth. While >0, `observe` skips `processQueue`. */
  private batchDepth = 0;

  constructor(
    ast: StmtNS.FileInput,
    functionEnvironments: FunctionEnvironments,
    passes: ReadonlyArray<Pass<any, any>> = DEFAULT_PASSES,
  ) {
    this.units = buildFunctionUnits(ast, functionEnvironments);
    for (const unit of this.units.values()) {
      if (unit.funcAst instanceof StmtNS.FunctionDef) {
        this.unitsByFdId.set(unit.funcAst.id, unit);
      }
    }
    this.rebuildNodeToUnit();

    for (const p of passes) this.register(p);
    this.factStore.onChange(c => this.handleFactChange(c));

    // Seed structuralPass for every unit to wake downstream passes.
    for (const unit of this.units.values()) {
      this.factStore.write(structuralPass, unit, 0);
    }

    // Synchrony tripwire.
    const fn = (this as unknown as Record<string, unknown>)["observe"];
    if (typeof fn !== "function" || (fn as Function).constructor.name === "AsyncFunction") {
      throw new Error(`Worklist.observe must be synchronous`);
    }
  }

  /** Register a pass. Idempotent. Requires `affectedKeys` or `coarse: true`. */
  register<K, V>(pass: Pass<K, V>): void {
    if (this.registeredPasses.indexOf(pass as Pass<any, any>) !== -1) return;
    if (pass.affectedKeys === undefined && pass.coarse !== true) {
      throw new Error(
        `[Worklist] pass "${pass.debugName}" must declare affectedKeys or coarse:true`,
      );
    }
    if (pass.affectedKeys !== undefined && pass.coarse === true) {
      throw new Error(
        `[Worklist] pass "${pass.debugName}" must not set both affectedKeys and coarse:true`,
      );
    }
    this.registeredPasses.push(pass as Pass<any, any>);
    for (const reader of pass.reads) {
      const list = this.passReaders.get(reader) ?? [];
      list.push(pass as Pass<any, any>);
      this.passReaders.set(reader, list);
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

  private handleFactChange(change: FactChange<unknown, unknown>): void {
    const readers = this.passReaders.get(change.pass as Pass<any, any>);
    // Structural change: let every pass evict stale keys.
    if ((change.pass as Pass<any, any>) === (structuralPass as Pass<any, any>)) {
      const unit = change.key as FunctionUnit;
      for (const p of this.registeredPasses) {
        if (p.prune === undefined) continue;
        const prev = this.factStore.readAll(p);
        const toEvict = p.prune(this.passCtx, unit, prev.keys());
        for (const k of toEvict) this.factStore.evict(p, k);
      }
    }
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
    }
  }

  /** Rebuild CFG + bump structuralPass for every pending unit. */
  private flushPendingRebuilds(): FunctionUnit[] {
    if (this.pendingRebuilds.size === 0) return [];
    const rebuilt: FunctionUnit[] = [];
    for (const unit of this.pendingRebuilds) {
      unit.generation++;
      unit.cfg = buildCFG(unit.body);
      const { blockMap, blockOfNode } = indexCFG(unit.cfg, unit);
      unit.blockMap = blockMap;
      unit.blockOfNode = blockOfNode;
      const cur = this.factStore.read(structuralPass, unit);
      this.factStore.write(structuralPass, unit, cur + 1);
      rebuilt.push(unit);
    }
    this.pendingRebuilds.clear();
    this.rebuildNodeToUnit();
    return rebuilt;
  }

  /** Rebuild nodeId → unit indexes (first-write-wins for outermost). */
  private rebuildNodeToUnit(): void {
    this.nodeToUnit.clear();
    this.nodeToUnits.clear();
    for (const unit of this.units.values()) {
      for (const nodeId of unit.blockOfNode.keys()) {
        if (!this.nodeToUnit.has(nodeId)) this.nodeToUnit.set(nodeId, unit);
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
    if (reader.affectedKeys !== undefined) {
      return reader.affectedKeys(this.passCtx, change.pass, change.key);
    }
    // coarse pass: re-run on all previously-written keys.
    return Array.from(this.factStore.readAll(reader).keys());
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
  typeAnalysisDfa,
  constAnalysisDfa,
  purityScopePass,
  callCountPass,
  deadBranchRule,
  constantFoldingRule,
  memoizationRule,
];

/** Source passes (runtime observations + structural). No `reads`. */
export const SOURCE_PASSES: ReadonlyArray<Pass<any, any>> = [
  structuralPass,
  runtimeWritePass,
  runtimeCallPass,
];

/** Analysis-tier passes. */
export const ANALYSIS_PASSES: ReadonlyArray<Pass<any, any>> = [
  typeAnalysisPass,
  constAnalysisPass,
  typeAnalysisDfa,
  constAnalysisDfa,
  purityScopePass,
  callCountPass,
];

/** Transform-tier passes. */
export const TRANSFORM_PASSES: ReadonlyArray<Pass<any, any>> = [
  deadBranchRule,
  constantFoldingRule,
  memoizationRule,
];
