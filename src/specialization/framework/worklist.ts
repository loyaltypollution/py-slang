// Priority-scheduled worklist for pass-graph dispatch.

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

export interface WorklistStats {
  readonly itemsProcessed: number;
  readonly analysisItemsProcessed: number;
  readonly transformItemsProcessed: number;
  readonly transformRounds: number;
  readonly drainCalls: number;
  readonly wallClockMs: number;
  /** Max combined depth across tier queues, sampled on enqueue. */
  readonly peakQueueDepth: number;
}

type QItem = { pass: Pass<any, any>; key: unknown };

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
  // Tier-indexed FIFO queues.
  private readonly runtimeQ: QItem[] = [];
  private readonly analysisQ: QItem[] = [];
  private readonly transformQ: QItem[] = [];
  /** Dedup — at most one pending entry per (pass, key). */
  private readonly pendingKeysByPass = new Map<Pass<any, any>, Set<unknown>>();
  private draining = false;

  /** Count of pending analysis items per unit. */
  private readonly analysisPendingByUnit = new Map<FunctionUnit, number>();

  // Perf counters
  private _itemsProcessed = 0;
  private _analysisItemsProcessed = 0;
  private _transformItemsProcessed = 0;
  private _transformRounds = 0;
  private _drainCalls = 0;
  private _wallClockMs = 0;
  private _peakQueueDepth = 0;

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

  /** Drain to fixpoint. */
  converge(): void {
    this.drain();
  }

  /** Incremental drain; returns true if any units changed. */
  tick(limit?: number): boolean {
    return this.drain(limit).size > 0;
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

  /** Runtime-observation entry: write and drain synchronously. Re-entry guarded. */
  observe<K, V>(pass: Pass<K, V>, key: K, value: V): void {
    this.factStore.write(pass, key, value);
    this.drainPasses();
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
    const item: QItem = { pass: p, key };

    const tier = p.tier ?? "analysis";
    if (tier === "runtime") {
      this.runtimeQ.push(item);
    } else if (tier === "transform") {
      this.transformQ.push(item);
    } else {
      this.analysisQ.push(item);
      const unit = this.unitOfKey(key);
      if (unit !== undefined) {
        this.analysisPendingByUnit.set(unit, (this.analysisPendingByUnit.get(unit) ?? 0) + 1);
      }
    }
    const depth = this.runtimeQ.length + this.analysisQ.length + this.transformQ.length;
    if (depth > this._peakQueueDepth) this._peakQueueDepth = depth;
  }

  /** Drain one pass-dispatch round. Tier order: runtime < analysis < transform;
   *  transforms defer while analysis is pending for the same unit. */
  drainPasses(): void {
    if (this.draining) return;
    this.draining = true;
    try {
      while (true) {
        const item = this.popNextItem();
        if (item === undefined) break;
        this.pendingKeysByPass.get(item.pass)?.delete(item.key);
        const itemTier = item.pass.tier ?? "analysis";
        if (itemTier === "analysis") {
          const unit = this.unitOfKey(item.key);
          if (unit !== undefined) {
            const n = (this.analysisPendingByUnit.get(unit) ?? 0) - 1;
            if (n <= 0) this.analysisPendingByUnit.delete(unit);
            else this.analysisPendingByUnit.set(unit, n);
          }
        }
        const value = item.pass.transfer(this.passCtx, item.key);
        if (value !== undefined) {
          this.factStore.write(item.pass, item.key, value);
        }
        this._itemsProcessed++;
        if (itemTier === "analysis") this._analysisItemsProcessed++;
        else if (itemTier === "transform") this._transformItemsProcessed++;
      }
    } finally {
      this.draining = false;
    }
  }

  /** Pop in tier order; skips transform items with pending analysis on same unit. */
  private popNextItem(): QItem | undefined {
    if (this.runtimeQ.length > 0) return this.runtimeQ.shift();
    if (this.analysisQ.length > 0) return this.analysisQ.shift();
    for (let i = 0; i < this.transformQ.length; i++) {
      const item = this.transformQ[i];
      const unit = this.unitOfKey(item.key);
      if (unit !== undefined && this.analysisPendingForUnit(unit)) continue;
      this.transformQ.splice(i, 1);
      return item;
    }
    return undefined;
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

  private unitOfKey(key: unknown): FunctionUnit | undefined {
    if (typeof key !== "object" || key === null) return undefined;
    if ("funcAst" in key) return key as unknown as FunctionUnit;
    if ("kind" in key) return this.units.get(key as StmtNS.FileInput | StmtNS.FunctionDef);
    return undefined;
  }

  private analysisPendingForUnit(unit: FunctionUnit): boolean {
    return (this.analysisPendingByUnit.get(unit) ?? 0) > 0;
  }

  drain(limit = Infinity): ReadonlySet<StmtNS.FileInput | StmtNS.FunctionDef> {
    const t0 = performance.now();
    this._drainCalls++;
    const changed = new Set<StmtNS.FileInput | StmtNS.FunctionDef>();
    let processed = 0;

    while (processed < limit) {
      this.drainPasses();
      // CFG rebuilds bump structuralPass, re-enqueuing downstream work.
      const rebuilt = this.flushPendingRebuilds();

      if (rebuilt.length === 0) break;

      this._transformRounds++;
      for (const unit of rebuilt) {
        changed.add(unit.funcAst);
        processed++;
      }
    }

    this._wallClockMs += performance.now() - t0;
    return changed;
  }

  /** Current structural version for `unit` (value of `structuralPass`). */
  structuralVersionOf(unit: FunctionUnit): number {
    return this.factStore.read(structuralPass, unit);
  }

  private get queueDepth(): number {
    return this.runtimeQ.length + this.analysisQ.length + this.transformQ.length;
  }

  get idle(): boolean {
    return this.queueDepth === 0 && this.pendingRebuilds.size === 0;
  }

  get pending(): number {
    return this.queueDepth + this.pendingRebuilds.size;
  }

  get stats(): WorklistStats {
    return Object.freeze({
      itemsProcessed: this._itemsProcessed,
      analysisItemsProcessed: this._analysisItemsProcessed,
      transformItemsProcessed: this._transformItemsProcessed,
      transformRounds: this._transformRounds,
      drainCalls: this._drainCalls,
      wallClockMs: this._wallClockMs,
      peakQueueDepth: this._peakQueueDepth,
    });
  }

  resetStats(): void {
    this._itemsProcessed = 0;
    this._analysisItemsProcessed = 0;
    this._transformItemsProcessed = 0;
    this._transformRounds = 0;
    this._drainCalls = 0;
    this._wallClockMs = 0;
    this._peakQueueDepth = 0;
  }

}

/** Default production pass set. Tests may pass a subset for isolation. */
export const DEFAULT_PASSES: ReadonlyArray<Pass<any, any>> = [
  structuralPass,
  runtimeWritePass,
  runtimeCallPass,
  typeAnalysisPass,
  constAnalysisPass,
  typeAnalysisDfa.blockKeyedPass,
  constAnalysisDfa.blockKeyedPass,
  purityScopePass,
  callCountPass,
  deadBranchRule,
  constantFoldingRule,
  memoizationRule,
];
