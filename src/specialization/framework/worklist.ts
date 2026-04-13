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

type QItem = { pass: Pass<any, any>; key: unknown };

export class Worklist {
  readonly units: ReadonlyMap<StmtNS.FileInput | StmtNS.FunctionDef, FunctionUnit>;
  /** funcAst.id → owning unit. Stable for the life of the Worklist: unit
   *  Map membership doesn't change after construction (CFG rebuilds mutate
   *  units in place), and `FunctionDef.id` is assigned at parse time. */
  private readonly unitsByFdId: Map<number, FunctionUnit> = new Map();

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
  /** Tier-indexed FIFO queues. `runtimeQ`/`analysisQ` drain strict-FIFO via
   *  `shift()`; `transformQ` is scanned head→tail for the first item whose
   *  unit has no pending analysis work. Queue depths stay small (<100), so
   *  O(n) `shift` is cheaper than maintaining head indices + compaction. */
  private readonly runtimeQ: QItem[] = [];
  private readonly analysisQ: QItem[] = [];
  private readonly transformQ: QItem[] = [];
  /** Global deduper — at most one pending entry per (pass, key). */
  private readonly pendingKeysByPass = new Map<Pass<any, any>, Set<unknown>>();
  private draining = false;

  /** Counter: analysis-tier pass items pending per unit. Maintained incrementally
   *  by enqueue/drain so `analysisPendingForUnit` is O(1). */
  private readonly analysisPendingByUnit = new Map<FunctionUnit, number>();

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
    passes: ReadonlyArray<Pass<any, any>> = DEFAULT_PASSES,
  ) {
    this.units = buildFunctionUnits(ast, functionEnvironments);
    for (const unit of this.units.values()) {
      if (unit.funcAst instanceof StmtNS.FunctionDef) {
        this.unitsByFdId.set(unit.funcAst.id, unit);
      }
    }

    for (const p of passes) this.register(p);
    this.factStore.onChange(c => this.handleFactChange(c));

    // Seed `structuralPass` for every unit so analyses + transforms wake via
    // their declared reads. First write fires onChange because
    // `hadPrev === false`; subsequent no-op writes at the same version are
    // suppressed by the equality gate.
    for (const unit of this.units.values()) {
      this.factStore.write(structuralPass, unit, 0);
    }

    // Synchrony tripwire: reject `async`-declared observe. TS accepts
    // `() => Promise<void>` where `() => void` is declared, so check at runtime.
    const fn = (this as unknown as Record<string, unknown>)["observe"];
    if (typeof fn !== "function" || (fn as Function).constructor.name === "AsyncFunction") {
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
    const p = pass as Pass<any, any>;
    let pending = this.pendingKeysByPass.get(p);
    if (pending === undefined) {
      pending = new Set();
      this.pendingKeysByPass.set(p, pending);
    }
    if (pending.has(key)) return;
    pending.add(key);
    const item: QItem = { pass: p, key };

    // Route to tier-indexed queue. Effective tier defaults to "analysis".
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

  /**
   * Pop in tier order: runtime, analysis, then the first transform-tier item
   * whose unit has no pending analysis work.
   */
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
    unitFor: (funcAst: StmtNS.FileInput | StmtNS.FunctionDef) => this.units.get(funcAst),
    unitForNode: (nodeId: number) => {
      for (const unit of this.units.values()) {
        if (unit.blockOfNode.has(nodeId)) return unit;
      }
      return undefined;
    },
    unitForFdId: (fdId: number) => this.unitsByFdId.get(fdId),
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
      const { blockMap, blockOfNode } = indexCFG(unit.cfg, unit);
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

  private unitOfKey(key: unknown): FunctionUnit | undefined {
    if (typeof key !== "object" || key === null) return undefined;
    if ("funcAst" in key) return key as unknown as FunctionUnit;
    if ("kind" in key) return this.units.get(key as StmtNS.FileInput | StmtNS.FunctionDef);
    return undefined;
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
      }
    }

    this._wallClockMs += performance.now() - t0;
    return changed;
  }

  /** Current structural version for `unit` — the value of `structuralPass` in the fact store. */
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

}

/**
 * Default production pass set registered by `Worklist`. Tests can pass
 * a subset (or `[]`) to `new Worklist(ast, envs, passes)` to exercise
 * dispatch in isolation.
 */
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
