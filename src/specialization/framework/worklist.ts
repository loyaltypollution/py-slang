// Unified priority-scheduled worklist (pass-graph dispatch).

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

// ── Performance stats ───────────────────────────────────────────────────────

export interface WorklistStats {
  readonly itemsProcessed: number;
  readonly analysisItemsProcessed: number;
  readonly transformItemsProcessed: number;
  readonly transformRounds: number;
  readonly drainCalls: number;
  readonly wallClockMs: number;
}

// ── Worklist ────────────────────────────────────────────────────────────────

export class Worklist {
  readonly units: ReadonlyMap<StmtNS.FileInput | StmtNS.FunctionDef, FunctionUnit>;

  /** Units with a transform-tier "fired" write that have not yet had their
   *  CFG rebuilt. Populated by `handleFactChange`; drained after
   *  `drainPasses` finishes so pruning doesn't clear fired markers mid-drain. */
  private readonly pendingRebuilds = new Set<FunctionUnit>();

  // Pass-graph dispatch: FactStore + subscription graph. On a lattice-change
  // write to pass `p`, every registered reader `p'` whose `reads` contains
  // `p` is enqueued for every key in `p'.affectedKeys?.(p, k)` (or all
  // previously-written keys if `p'.coarse === true`).
  readonly factStore = new FactStore();
  private readonly registeredPasses: Pass<any, any>[] = [];
  private readonly passReaders = new Map<Pass<any, any>, Pass<any, any>[]>();
  private readonly passQueue: Array<{ pass: Pass<any, any>; key: unknown }> = [];
  /** Deduper for passQueue — at most one pending entry per (pass, key). */
  private readonly passQueueSet = new Set<string>();
  private draining = false;

  /** Counter: analysis-tier pass items pending per unit. Maintained incrementally
   *  by enqueue/drain so `analysisPendingForUnit` is O(1). */
  private readonly analysisPendingByUnit = new Map<FunctionUnit, number>();

  /** key → unit resolution for pass-queue items. Populated on enqueue when the
   *  key is an object we can map to a unit. */
  private readonly keyToUnit = new WeakMap<object, FunctionUnit>();

  // Perf counters
  private _itemsProcessed = 0;
  private _analysisItemsProcessed = 0;
  private _transformItemsProcessed = 0;
  private _transformRounds = 0;
  private _drainCalls = 0;
  private _wallClockMs = 0;

  constructor(
    ast: StmtNS.FileInput,
    functionEnvironments: FunctionEnvironments,
  ) {
    this.units = buildFunctionUnits(ast, functionEnvironments);

    this.register(structuralPass);
    this.register(runtimeWritePass);
    this.register(runtimeCallPass);
    this.register(typeAnalysisPass);
    this.register(constAnalysisPass);
    this.register(typeAnalysisDfa.blockKeyedPass);
    this.register(constAnalysisDfa.blockKeyedPass);
    this.register(purityScopePass);
    this.register(callCountPass);
    this.register(deadBranchRule);
    this.register(constantFoldingRule);
    this.register(memoizationRule);
    this.factStore.onChange(c => this.handleFactChange(c));

    // Seed `structuralPass` for every unit so analyses + transforms wake via
    // their declared reads. First write fires onChange because
    // `hadPrev === false`; subsequent no-op writes at the same version are
    // suppressed by the equality gate.
    for (const unit of this.units.values()) {
      this.factStore.write(structuralPass, unit, 0);
    }

    // Synchrony tripwire: reject `async`-declared observe method at
    // construction. TS accepts `() => Promise<void>` where `() => void` is
    // declared, so this must be checked at runtime.
    const fn = (this as unknown as Record<string, unknown>)["observe"];
    if (typeof fn !== "function") {
      throw new Error(`Worklist.observe was replaced with a non-function value`);
    }
    if ((fn as Function).constructor.name === "AsyncFunction") {
      throw new Error(`Worklist.observe must be synchronous`);
    }
  }

  // ── Reactive API ───────────────────────────────────────────────────────

  /** Drain to fixpoint (initial pass). */
  converge(): void {
    this.drain();
  }

  /**
   * Process pending work incrementally. Returns true if any units changed.
   * Evaluators call this after execution to drain work queued during the run.
   */
  tick(limit?: number): boolean {
    return this.drain(limit).size > 0;
  }

  /**
   * Register a pass with the dispatch graph. Idempotent. Every pass must
   * either declare `affectedKeys` or set `coarse: true` — fail fast otherwise.
   */
  register<K, V>(pass: Pass<K, V>): void {
    if (this.registeredPasses.indexOf(pass as Pass<any, any>) !== -1) return;
    if (pass.affectedKeys === undefined && pass.coarse !== true) {
      throw new Error(
        `[Worklist] pass "${pass.debugName}" must declare affectedKeys or coarse:true`,
      );
    }
    this.registeredPasses.push(pass as Pass<any, any>);
    for (const reader of pass.reads) {
      const list = this.passReaders.get(reader) ?? [];
      list.push(pass as Pass<any, any>);
      this.passReaders.set(reader, list);
    }
  }

  /**
   * Runtime-observation API for `runtime`-tier source passes. Writes
   * `(pass, key) → value` into the fact store, then drains synchronously
   * so transform side-effects land before the next interpreter instruction.
   * Re-entry is guarded by `drainPasses`.
   */
  observe<K, V>(pass: Pass<K, V>, key: K, value: V): void {
    this.factStore.write(pass, key, value);
    this.drainPasses();
  }

  /**
   * Enqueue a `(pass, key)` item for re-transfer. Deduped: a second
   * enqueue for the same pair before drain is a no-op.
   */
  enqueue<K, V>(pass: Pass<K, V>, key: K): void {
    const tag = this.passItemTag(pass as Pass<any, any>, key);
    if (this.passQueueSet.has(tag)) return;
    this.passQueueSet.add(tag);
    this.passQueue.push({ pass: pass as Pass<any, any>, key });

    // Resolve key→unit for O(1) unitOfKey lookups.
    if (typeof key === "object" && key !== null) {
      const obj = key as object;
      if ("funcAst" in obj) {
        this.keyToUnit.set(obj, obj as unknown as FunctionUnit);
      } else if ("kind" in obj) {
        const unit = this.units.get(obj as StmtNS.FileInput | StmtNS.FunctionDef);
        if (unit !== undefined) this.keyToUnit.set(obj, unit);
      }
    }

    // Incremental analysis-pending counter. Effective tier defaults to "analysis".
    const tier = (pass as Pass<any, any>).tier ?? "analysis";
    if (tier === "analysis") {
      const unit = this.unitOfKey(key);
      if (unit !== undefined) {
        this.analysisPendingByUnit.set(unit, (this.analysisPendingByUnit.get(unit) ?? 0) + 1);
      }
    }
  }

  /**
   * Drain the pass-graph queue to fixpoint. Order: tier (runtime < analysis
   * < transform < jit), FIFO within tier. Transforms defer while analysis
   * items are pending for the same unit.
   */
  drainPasses(): void {
    if (this.draining) return;
    this.draining = true;
    try {
      while (this.passQueue.length > 0) {
        const idx = this.pickNextPassItem();
        if (idx === -1) break;
        const item = this.passQueue.splice(idx, 1)[0];
        const tag = this.passItemTag(item.pass, item.key);
        this.passQueueSet.delete(tag);
        // Decrement analysis-pending counter for this unit, if applicable.
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
        if (item.pass.tier === "analysis" || item.pass.tier === undefined) {
          this._analysisItemsProcessed++;
          this._itemsProcessed++;
        }
      }
    } finally {
      this.draining = false;
    }
  }

  private readonly _keyIds = new WeakMap<object, number>();
  private _nextKeyId = 1;

  private passItemTag(pass: Pass<any, any>, key: unknown): string {
    const passTag = (pass.id as symbol).toString();
    if (typeof key === "object" && key !== null) {
      let kid = this._keyIds.get(key);
      if (kid === undefined) {
        kid = this._nextKeyId++;
        this._keyIds.set(key, kid);
      }
      return `${passTag}::o${kid}`;
    }
    return `${passTag}::${String(key)}`;
  }

  private readonly passCtx: PassCtx = {
    read: <K2, V2>(p: Pass<K2, V2>, key: K2) => this.factStore.read(p, key),
    readAll: <K2, V2>(p: Pass<K2, V2>) => this.factStore.readAll(p),
    unitFor: (scope: StmtNS.FileInput | StmtNS.FunctionDef) => this.units.get(scope),
    unitForBlock: (block) => {
      for (const unit of this.units.values()) {
        if (unit.blockMap.get(block.id) === block) return unit;
      }
      return undefined;
    },
    unitForNode: (nodeId: number) => {
      for (const unit of this.units.values()) {
        if (unit.blockOfNode.has(nodeId)) return unit;
      }
      return undefined;
    },
    factStore: this.factStore,
  };

  private handleFactChange(change: FactChange<unknown, unknown>): void {
    const readers = this.passReaders.get(change.pass as Pass<any, any>);
    // On a structural change, let every pass evict stale keys.
    if ((change.pass as Pass<any, any>) === (structuralPass as Pass<any, any>)) {
      const unit = change.key as FunctionUnit;
      for (const p of this.registeredPasses) {
        if (p.prune === undefined) continue;
        const prev = this.factStore.readAll(p);
        const toEvict = p.prune(this.passCtx, unit, prev.keys());
        for (const k of toEvict) this.factStore.evict(p, k);
      }
    }
    // Transform-tier "fired" writes: defer the CFG rebuild until after the
    // current drainPasses completes, so prune (triggered by the subsequent
    // structuralPass bump) doesn't clear the fired marker mid-drain.
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

  /** Rebuild CFG + bump structuralPass for every pending unit. Returns the
   *  scopes rebuilt, so drain() can roll them into its `changed` set. */
  private flushPendingRebuilds(): FunctionUnit[] {
    if (this.pendingRebuilds.size === 0) return [];
    const rebuilt: FunctionUnit[] = [];
    for (const unit of this.pendingRebuilds) {
      unit.generation++;
      unit.cfg = buildCFG(unit.body);
      const { blockMap, blockOfNode } = indexCFG(unit.cfg);
      unit.blockMap = blockMap;
      unit.blockOfNode = blockOfNode;
      const cur = this.factStore.read(structuralPass, unit);
      this.factStore.write(structuralPass, unit, cur + 1);
      rebuilt.push(unit);
    }
    this.pendingRebuilds.clear();
    return rebuilt;
  }

  private computeAffectedKeys(
    reader: Pass<any, any>,
    change: FactChange<unknown, unknown>,
  ): Iterable<unknown> {
    if (reader.affectedKeys !== undefined) {
      return reader.affectedKeys(this.passCtx, change.pass, change.key);
    }
    // coarse: re-run on all previously-written keys.
    return Array.from(this.factStore.readAll(reader).keys());
  }

  private pickNextPassItem(): number {
    const tierOrder: Record<string, number> = {
      runtime: 0,
      analysis: 1,
      transform: 2,
    };
    const defaultTier = 1; // "analysis" default per plan
    let bestIdx = -1;
    let bestTier = Infinity;
    for (let i = 0; i < this.passQueue.length; i++) {
      const { pass, key } = this.passQueue[i];
      const tier = pass.tier ? tierOrder[pass.tier] : defaultTier;
      // Defer transforms if any analysis item is pending for the same unit.
      if (pass.tier === "transform") {
        const unit = this.unitOfKey(key);
        if (unit !== undefined && this.analysisPendingForUnit(unit)) continue;
      }
      if (tier < bestTier) {
        bestTier = tier;
        bestIdx = i;
      }
    }
    return bestIdx;
  }

  private unitOfKey(key: unknown): FunctionUnit | undefined {
    return typeof key === "object" && key !== null
      ? this.keyToUnit.get(key as object)
      : undefined;
  }

  private analysisPendingForUnit(unit: FunctionUnit): boolean {
    return (this.analysisPendingByUnit.get(unit) ?? 0) > 0;
  }


  // ── Drain ────────────────────────────────────────────────────────────────

  drain(limit = Infinity): ReadonlySet<StmtNS.FileInput | StmtNS.FunctionDef> {
    const t0 = performance.now();
    this._drainCalls++;
    const changed = new Set<StmtNS.FileInput | StmtNS.FunctionDef>();
    let processed = 0;

    while (processed < limit) {
      // Drain analysis + transform pass-graph items to fixpoint.
      this.drainPasses();

      // Apply any CFG rebuilds queued by transform fires. Each rebuild bumps
      // structuralPass, which fans out fresh work onto the pass queue; the
      // outer loop picks it up on the next iteration.
      const rebuilt = this.flushPendingRebuilds();
      if (rebuilt.length === 0) break;

      this._transformRounds++;
      for (const unit of rebuilt) {
        changed.add(unit.funcAst);
        processed++;
        this._itemsProcessed++;
        this._transformItemsProcessed++;
      }
    }

    this._wallClockMs += performance.now() - t0;
    return changed;
  }

  /** Current structural version for `unit` — the value of `structuralPass` in the fact store. */
  structuralVersionOf(unit: FunctionUnit): number {
    return this.factStore.read(structuralPass, unit);
  }

  get idle(): boolean {
    return this.passQueue.length === 0 && this.pendingRebuilds.size === 0;
  }

  get pending(): number {
    return this.passQueue.length + this.pendingRebuilds.size;
  }

  get stats(): WorklistStats {
    return Object.freeze({
      itemsProcessed: this._itemsProcessed,
      analysisItemsProcessed: this._analysisItemsProcessed,
      transformItemsProcessed: this._transformItemsProcessed,
      transformRounds: this._transformRounds,
      drainCalls: this._drainCalls,
      wallClockMs: this._wallClockMs,
    });
  }

  resetStats(): void {
    this._itemsProcessed = 0;
    this._analysisItemsProcessed = 0;
    this._transformItemsProcessed = 0;
    this._transformRounds = 0;
    this._drainCalls = 0;
    this._wallClockMs = 0;
  }

  // ── Transform processing ────────────────────────────────────────────────

}
