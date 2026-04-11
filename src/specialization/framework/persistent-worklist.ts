// src/specialization/framework/persistent-worklist.ts — unified priority-scheduled worklist
//
// Two-tier priority: analysis blocks process before transforms.
// Within analysis, earlier modules (e.g., type before const) complete before later ones.
// This guarantees transforms only fire at local fixpoint.

import type { BasicBlock, BlockId, CFG } from "./cfg";
import { buildCFG } from "./cfg";
import type { HintStore } from "./hint";
import type { AnalysisModule, TransformRule } from "./interfaces";
import type { ScopeKey, VersionedFunctionUnit } from "./function-unit";
import type { SlotLookup } from "./slot-table";
import { applyTransformPass } from "./transform";
import type { AnalysisSession } from "./worklist";
import {
  computeBlockIN,
  makeSession,
  outgoingBlocks,
  seedBlock,
  sentinelBlock,
  transferBlock,
} from "./worklist";

// ── Internal queue items ────────────────────────────────────────────────────

interface QueuedBlock {
  readonly scopeKey: ScopeKey;
  readonly blockId: BlockId;
  /** Scope generation at enqueue time. Stale items (wrong generation) are skipped. */
  readonly generation: number;
}

interface QueuedTransform {
  readonly scopeKey: ScopeKey;
  readonly generation: number;
}

// ── External work items (public API for enqueue) ────────────────────────────

export interface ObservationItem {
  readonly kind: "observation";
  readonly scopeKey: ScopeKey;
  readonly slot: number;
  readonly value: unknown;
}

export interface InvalidateItem {
  readonly kind: "invalidate";
  readonly scopeKey: ScopeKey;
}

export type ExternalWorkItem = ObservationItem | InvalidateItem;

// ── Performance stats ──────────────────────────────────────────────────────

export interface WorklistStats {
  readonly itemsProcessed: number;
  readonly analysisItemsProcessed: number;
  readonly transformItemsProcessed: number;
  readonly transformRounds: number;
  readonly drainCalls: number;
  readonly wallClockMs: number;
}

// ── Per-scope state ─────────────────────────────────────────────────────────

interface ScopeWorkState {
  cfg: CFG;
  sessions: AnalysisSession<any>[];
  readonly unit: VersionedFunctionUnit;
  blockMap: Map<BlockId, BasicBlock>;
  generation: number;
}

// ── PersistentWorklist ──────────────────────────────────────────────────────

/**
 * Unified priority-scheduled worklist for all optimization work.
 *
 * Maintains one queue per analysis module (ordered by module index) plus one
 * queue for transforms. `drain()` always processes the lowest non-empty queue,
 * guaranteeing that all analysis converges before any transform fires.
 *
 * When transforms change the AST, the CFG is rebuilt, analysis sessions reset,
 * and analysis blocks re-seeded — creating the fixpoint feedback loop.
 */
export class PersistentWorklist {
  // One queue per analysis module: queues[i] holds blocks for analyses[i]
  private readonly analysisQueues: QueuedBlock[][];
  private readonly analysisHeads: number[];

  // Transform queue (lowest priority)
  private readonly transformQueue: QueuedTransform[] = [];
  private transformHead = 0;

  private readonly scopes = new Map<ScopeKey, ScopeWorkState>();

  // ── Performance counters ───────────────────────────────────────────────
  private _itemsProcessed = 0;
  private _analysisItemsProcessed = 0;
  private _transformItemsProcessed = 0;
  private _transformRounds = 0;
  private _drainCalls = 0;
  private _wallClockMs = 0;

  constructor(
    private readonly analyses: readonly AnalysisModule<any>[],
    private readonly transforms: readonly TransformRule[],
  ) {
    this.analysisQueues = analyses.map(() => []);
    this.analysisHeads = analyses.map(() => 0);
  }

  // ── Scope management ────────────────────────────────────────────────────

  /** Register a scope for optimization. Builds CFG, creates sessions, seeds work. */
  addScope(key: ScopeKey, unit: VersionedFunctionUnit): void {
    const cfg = buildCFG(unit.body);
    const sessions = this.analyses.map(m => makeSession(m, cfg));
    const blockMap = new Map<BlockId, BasicBlock>();
    for (const block of cfg.blocks) blockMap.set(block.id, block);

    const state: ScopeWorkState = { cfg, sessions, unit, blockMap, generation: 0 };
    this.scopes.set(key, state);

    this.seedAnalysis(key, state);
    this.enqueueTransform(key, state.generation);
  }

  // ── External enqueue ──────────────────────────────────────────────────────

  /** Inject external work (runtime observations, scope invalidation). */
  enqueue(item: ExternalWorkItem): void {
    const state = this.scopes.get(item.scopeKey);
    if (!state) return;

    if (item.kind === "invalidate") {
      this.rebuildAndReseed(item.scopeKey, state);
    }
    // observation: future — write lattice value to HintStore, then invalidate
  }

  // ── Drain ─────────────────────────────────────────────────────────────────

  /**
   * Process up to `limit` items, respecting priority order.
   * Returns the set of scopes whose units had material changes.
   */
  drain(limit = Infinity): ReadonlySet<ScopeKey> {
    const t0 = performance.now();
    this._drainCalls++;
    const changed = new Set<ScopeKey>();
    let processed = 0;

    while (processed < limit) {
      const qIdx = this.findActiveQueue();
      if (qIdx === -1) break;

      if (qIdx < this.analyses.length) {
        if (this.processAnalysisBlock(qIdx, changed)) {
          processed++;
          this._itemsProcessed++;
          this._analysisItemsProcessed++;
        }
      } else {
        this.processTransform(changed);
        processed++;
        this._itemsProcessed++;
        this._transformItemsProcessed++;
        this._transformRounds++;
      }
    }

    this._wallClockMs += performance.now() - t0;
    return changed;
  }

  get idle(): boolean {
    return this.findActiveQueue() === -1;
  }

  get pending(): number {
    let n = 0;
    for (let i = 0; i < this.analysisQueues.length; i++) {
      n += this.analysisQueues[i].length - this.analysisHeads[i];
    }
    n += this.transformQueue.length - this.transformHead;
    return n;
  }

  // ── Performance stats ───────────────────────────────────────────────────

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

  // ── Internal: queue selection ─────────────────────────────────────────────

  /** Returns index of lowest non-empty queue, or -1 if idle. */
  private findActiveQueue(): number {
    for (let i = 0; i < this.analysisQueues.length; i++) {
      if (this.analysisHeads[i] < this.analysisQueues[i].length) return i;
    }
    if (this.transformHead < this.transformQueue.length) return this.analyses.length;
    return -1;
  }

  // ── Internal: analysis block processing ───────────────────────────────────

  /**
   * Process one block from the analysis queue at index `qIdx`.
   * Returns true if the item was current (processed), false if stale (skipped).
   */
  private processAnalysisBlock(qIdx: number, changed: Set<ScopeKey>): boolean {
    const queue = this.analysisQueues[qIdx];
    const item = queue[this.analysisHeads[qIdx]++];

    // Compact queue when head gets far ahead
    if (this.analysisHeads[qIdx] > 256 && this.analysisHeads[qIdx] > queue.length / 2) {
      this.analysisQueues[qIdx] = queue.slice(this.analysisHeads[qIdx]);
      this.analysisHeads[qIdx] = 0;
    }

    const state = this.scopes.get(item.scopeKey);
    if (!state || item.generation !== state.generation) return false; // stale

    const session = state.sessions[qIdx];
    const block = state.blockMap.get(item.blockId);
    if (!block) return false; // block no longer exists

    const inEnv = computeBlockIN(block, session);
    const outEnv = transferBlock(block, inEnv, session, state.unit.hints, state.unit.slotLookup);

    const prevOut = session.out.get(block.id) ?? null;
    if (prevOut === null || !outEnv.equals(prevOut, session.module.leq.bind(session.module))) {
      session.out.set(block.id, outEnv);
      changed.add(item.scopeKey);

      const direction = session.module.direction;
      const sentinel = sentinelBlock(state.cfg, direction);
      for (const next of outgoingBlocks(block, direction)) {
        if (next !== sentinel) {
          this.enqueueAnalysisBlock(qIdx, item.scopeKey, next.id, state.generation);
        }
      }
    }

    return true;
  }

  // ── Internal: transform processing ────────────────────────────────────────

  private processTransform(changed: Set<ScopeKey>): void {
    const item = this.transformQueue[this.transformHead++];

    // Compact
    if (this.transformHead > 64 && this.transformHead > this.transformQueue.length / 2) {
      this.transformQueue.splice(0, this.transformHead);
      this.transformHead = 0;
    }

    const state = this.scopes.get(item.scopeKey);
    if (!state || item.generation !== state.generation) return; // stale

    let anyChanged = false;
    for (const rule of this.transforms) {
      anyChanged = applyTransformPass(state.unit.body, rule, state.unit.hints) || anyChanged;
    }

    // Snapshot hint version regardless of transform outcome
    state.unit.hintVersionSnapshot = state.unit.hints.version;

    if (anyChanged) {
      state.unit.structuralVersion++;
      changed.add(item.scopeKey);
      this.rebuildAndReseed(item.scopeKey, state);
    }
  }

  // ── Internal: seeding helpers ─────────────────────────────────────────────

  /** Rebuild CFG, reset sessions, re-seed analysis + transforms. */
  private rebuildAndReseed(key: ScopeKey, state: ScopeWorkState): void {
    state.generation++;
    state.cfg = buildCFG(state.unit.body);
    state.blockMap.clear();
    for (const block of state.cfg.blocks) state.blockMap.set(block.id, block);
    state.sessions = this.analyses.map(m => makeSession(m, state.cfg));

    this.seedAnalysis(key, state);
    this.enqueueTransform(key, state.generation);
  }

  /** Seed all analysis queues for a scope. */
  private seedAnalysis(key: ScopeKey, state: ScopeWorkState): void {
    for (let i = 0; i < this.analyses.length; i++) {
      const direction = this.analyses[i].direction;
      const seed = seedBlock(state.cfg, direction);
      this.enqueueAnalysisBlock(i, key, seed.id, state.generation);
    }
  }

  // Note: no dedup on analysis block enqueue. The same block may appear multiple
  // times (once per predecessor that propagates). This causes redundant transfers
  // but not correctness issues — the convergence check (outEnv.equals(prevOut))
  // short-circuits repeated processing. Bounded by CFG size × fan-in.
  private enqueueAnalysisBlock(
    qIdx: number,
    scopeKey: ScopeKey,
    blockId: BlockId,
    generation: number,
  ): void {
    this.analysisQueues[qIdx].push({ scopeKey, blockId, generation });
  }

  private enqueueTransform(scopeKey: ScopeKey, generation: number): void {
    this.transformQueue.push({ scopeKey, generation });
  }
}
