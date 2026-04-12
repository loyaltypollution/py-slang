// src/specialization/framework/persistent-worklist.ts — unified priority-scheduled worklist
//
// Two-tier priority: analysis blocks process before transforms. Within analysis,
// earlier modules (e.g. type before const) complete before later ones, so
// transforms only fire at local fixpoint.
//
// This is also the push-side for runtime observations and the publish-side for
// reactive consumers: construct with (ast, environments), then call
// `converge()`, `tick()`, `observeWrite()`, `subscribe()`.

import type { ExprNS, StmtNS } from "../../ast-types";
import type { FunctionEnvironments } from "../../resolver";
import type { BasicBlock, BlockId, CFG } from "./cfg";
import { buildCFG } from "./cfg";
import type { FunctionUnit } from "./function-unit";
import { buildFunctionUnits } from "./function-unit";
import type { OptimizationHint } from "./hint";
import type { AnalysisModule, TransformRule } from "./interfaces";
import type { AnalysisKey } from "./hint";
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

// ── Queue items ─────────────────────────────────────────────────────────────

interface QueuedBlock {
  readonly scopeKey: StmtNS.FileInput | StmtNS.FunctionDef;
  readonly blockId: BlockId;
  readonly generation: number;
}

interface QueuedTransform {
  readonly scopeKey: StmtNS.FileInput | StmtNS.FunctionDef;
  readonly generation: number;
}

// ── External work items ─────────────────────────────────────────────────────

export interface ValueObservationItem {
  readonly kind: "value-observation";
  readonly scopeKey: StmtNS.FileInput | StmtNS.FunctionDef;
  readonly nodeId: number;
  readonly value: unknown;
}

export interface CallObservationItem {
  readonly kind: "call-observation";
  readonly scopeKey: StmtNS.FileInput | StmtNS.FunctionDef;
  readonly calleeKey: StmtNS.FileInput | StmtNS.FunctionDef;
}

export interface InvalidateItem {
  readonly kind: "invalidate";
  readonly scopeKey: StmtNS.FileInput | StmtNS.FunctionDef;
}

export type ExternalWorkItem = ValueObservationItem | CallObservationItem | InvalidateItem;

// ── Performance stats ───────────────────────────────────────────────────────

export interface WorklistStats {
  readonly itemsProcessed: number;
  readonly analysisItemsProcessed: number;
  readonly transformItemsProcessed: number;
  readonly transformRounds: number;
  readonly drainCalls: number;
  readonly wallClockMs: number;
}

// ── Subscribers ─────────────────────────────────────────────────────────────

export type Subscriber = (changed: ReadonlySet<StmtNS.FileInput | StmtNS.FunctionDef>) => void;

// ── Observation-capable analysis (narrowed subtype) ────────────────────────

type ObservingAnalysis = AnalysisModule<any> & {
  observeValue: NonNullable<AnalysisModule<any>["observeValue"]>;
  mergeIntoHint: NonNullable<AnalysisModule<any>["mergeIntoHint"]>;
};

// ── Per-scope state ─────────────────────────────────────────────────────────

interface ScopeWorkState {
  cfg: CFG;
  sessions: AnalysisSession<any>[];
  readonly unit: FunctionUnit;
  blockMap: Map<BlockId, BasicBlock>;
  generation: number;
}

// ── PersistentWorklist ──────────────────────────────────────────────────────

export class PersistentWorklist {
  readonly units: ReadonlyMap<StmtNS.FileInput | StmtNS.FunctionDef, FunctionUnit>;

  private readonly analysisQueues: QueuedBlock[][];
  private readonly analysisHeads: number[];
  private readonly transformQueue: QueuedTransform[] = [];
  private transformHead = 0;

  private readonly scopes = new Map<StmtNS.FileInput | StmtNS.FunctionDef, ScopeWorkState>();
  private readonly activeScopes = new Map<StmtNS.FileInput | StmtNS.FunctionDef, number>();
  private readonly subscribers = new Set<Subscriber>();

  /**
   * Pre-filtered subset of `analyses` that implement the runtime-observation
   * hooks. Observation handling iterates this list rather than re-checking
   * `observeValue` / `mergeIntoHint` on every analysis per write. The type
   * narrows both hooks to required so the loop body needs no non-null asserts.
   */
  private readonly observers: readonly ObservingAnalysis[];

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
    private readonly analyses: readonly AnalysisModule<any>[],
    private readonly transforms: readonly TransformRule[],
  ) {
    this.analysisQueues = analyses.map(() => []);
    this.analysisHeads = analyses.map(() => 0);
    this.observers = analyses.filter(
      (m): m is ObservingAnalysis =>
        m.observeValue !== undefined && m.mergeIntoHint !== undefined,
    );

    const analysisKeys: AnalysisKey<unknown>[] = analyses.map(m => m.key as AnalysisKey<unknown>);
    const units = buildFunctionUnits(ast, functionEnvironments, analysisKeys);
    this.units = units;
    for (const [key, unit] of units) this.addScope(key, unit);
  }

  private addScope(key: StmtNS.FileInput | StmtNS.FunctionDef, unit: FunctionUnit): void {
    const cfg = buildCFG(unit.body);
    const sessions = this.analyses.map(m => makeSession(m, cfg));
    const blockMap = new Map<BlockId, BasicBlock>();
    for (const block of cfg.blocks) blockMap.set(block.id, block);

    const state: ScopeWorkState = { cfg, sessions, unit, blockMap, generation: 0 };
    this.scopes.set(key, state);
    this.seedAnalysis(key, state);
    this.enqueueTransform(key, state.generation);
  }

  // ── Reactive API ───────────────────────────────────────────────────────

  /** Drain to fixpoint (initial pass). */
  converge(): void {
    this.notify(this.drain());
  }

  /** Process pending work incrementally. Returns true if any units changed. */
  tick(limit?: number): boolean {
    const changed = this.drain(limit);
    this.notify(changed);
    return changed.size > 0;
  }

  subscribe(cb: Subscriber): () => void {
    this.subscribers.add(cb);
    return () => this.subscribers.delete(cb);
  }

  /**
   * nodeId → owning FunctionUnit cache for `hintsFor`. Ownership is
   * structural (set by AST scope) and immutable across the worklist's
   * lifetime, so positive hits can be cached permanently. A miss may become
   * a hit later (hint populated by a transform), so misses are not cached.
   */
  private readonly nodeUnitCache = new Map<number, FunctionUnit>();

  /**
   * Look up the hint for an AST node by routing to the owning FunctionUnit.
   * Node IDs are globally unique, so a linear scan across units suffices —
   * every unit's HintStore keys on the same id space and at most one owns
   * any given id. Repeated lookups for the same node are O(1) via cache.
   */
  hintsFor(node: ExprNS.Expr | StmtNS.Stmt): OptimizationHint | undefined {
    const id = node.id;
    const cached = this.nodeUnitCache.get(id);
    if (cached !== undefined) return cached.hints.getById(id);
    for (const unit of this.units.values()) {
      const h = unit.hints.getById(id);
      if (h !== undefined) {
        this.nodeUnitCache.set(id, unit);
        return h;
      }
    }
    return undefined;
  }

  /**
   * Pin `scope` as active, run `fn`, then unpin and (on success) tick once so
   * any transforms parked during execution fire before returning. If `fn`
   * throws, we still deactivate but skip the tick: a thrown execution leaves
   * subscribers (e.g. OSRCoordinator → patchFunction) facing a dead runtime,
   * and we'd rather surface the original error than trigger swap machinery.
   */
  async withActiveScope<T>(scope: StmtNS.FileInput | StmtNS.FunctionDef, fn: () => Promise<T> | T): Promise<T> {
    this.activateScope(scope);
    let threw = false;
    try {
      return await fn();
    } catch (e) {
      threw = true;
      throw e;
    } finally {
      this.deactivateAndTick(scope, threw);
    }
  }

  /**
   * Contractually atomic deactivate-then-tick. The worklist parks transforms
   * for pinned scopes; unpinning must happen *before* the tick that fires
   * those transforms, or the transform stays parked for another tick that
   * may never come. Collapsing both into one private method removes the
   * "textual ordering" fragility that would bite if someone reordered the
   * two calls in the finally block of withActiveScope.
   */
  private deactivateAndTick(scope: StmtNS.FileInput | StmtNS.FunctionDef, threw: boolean): void {
    this.deactivateScope(scope);
    if (!threw) this.tick();
  }

  /**
   * Monotonic sentinel that bumps whenever any scope's hints change. Sum of
   * per-store monotonic versions — not a change count. Intended for
   * `useSyncExternalStore`-style "something changed" detection.
   */
  get hintStoreVersion(): number {
    let sum = 0;
    for (const unit of this.units.values()) sum += unit.hints.version;
    return sum;
  }

  observeWrite(scopeKey: StmtNS.FileInput | StmtNS.FunctionDef, rhsNode: ExprNS.Expr, rawValue: unknown): void {
    this.enqueue({ kind: "value-observation", scopeKey, nodeId: rhsNode.id, value: rawValue });
  }

  observeCall(scopeKey: StmtNS.FileInput | StmtNS.FunctionDef, calleeKey: StmtNS.FileInput | StmtNS.FunctionDef): void {
    this.enqueue({ kind: "call-observation", scopeKey, calleeKey });
  }

  // ── External enqueue ────────────────────────────────────────────────────

  enqueue(item: ExternalWorkItem): void {
    const state = this.scopes.get(item.scopeKey);
    if (!state) return;

    switch (item.kind) {
      case "invalidate":
        this.rebuildAndReseed(item.scopeKey, state);
        return;
      case "value-observation":
        if (this.handleValueObservation(item, state)) {
          this.rebuildAndReseed(item.scopeKey, state);
        }
        return;
      case "call-observation": {
        const calleeState = this.scopes.get(item.calleeKey);
        if (calleeState) this.rebuildAndReseed(item.calleeKey, calleeState);
        return;
      }
    }
  }

  activateScope(key: StmtNS.FileInput | StmtNS.FunctionDef): void {
    this.activeScopes.set(key, (this.activeScopes.get(key) ?? 0) + 1);
  }

  deactivateScope(key: StmtNS.FileInput | StmtNS.FunctionDef): void {
    const count = this.activeScopes.get(key);
    if (count === undefined) return;
    if (count <= 1) this.activeScopes.delete(key);
    else this.activeScopes.set(key, count - 1);
  }

  isScopeActive(key: StmtNS.FileInput | StmtNS.FunctionDef): boolean {
    return this.activeScopes.has(key);
  }

  private handleValueObservation(item: ValueObservationItem, state: ScopeWorkState): boolean {
    const hints = state.unit.hints;
    let next = hints.getById(item.nodeId) ?? {};

    for (const { observeValue, mergeIntoHint } of this.observers) {
      const lattice = observeValue(item.value);
      if (lattice === undefined) continue;
      next = mergeIntoHint(next, lattice);
    }

    return hints.setById(item.nodeId, next);
  }

  // ── Drain ────────────────────────────────────────────────────────────────

  drain(limit = Infinity): ReadonlySet<StmtNS.FileInput | StmtNS.FunctionDef> {
    const t0 = performance.now();
    this._drainCalls++;
    const changed = new Set<StmtNS.FileInput | StmtNS.FunctionDef>();
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
        if (this.processTransform(changed)) {
          processed++;
          this._itemsProcessed++;
          this._transformItemsProcessed++;
        }
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

  // ── Queue selection ─────────────────────────────────────────────────────

  private findActiveQueue(): number {
    for (let i = 0; i < this.analysisQueues.length; i++) {
      if (this.analysisHeads[i] < this.analysisQueues[i].length) return i;
    }
    if (this.hasProcessableTransform()) return this.analyses.length;
    return -1;
  }

  private hasProcessableTransform(): boolean {
    for (let i = this.transformHead; i < this.transformQueue.length; i++) {
      const item = this.transformQueue[i];
      const state = this.scopes.get(item.scopeKey);
      if (!state || item.generation !== state.generation) return true;
      if (!this.activeScopes.has(item.scopeKey)) return true;
    }
    return false;
  }

  // ── Analysis processing ─────────────────────────────────────────────────

  private processAnalysisBlock(qIdx: number, changed: Set<StmtNS.FileInput | StmtNS.FunctionDef>): boolean {
    const queue = this.analysisQueues[qIdx];
    const item = queue[this.analysisHeads[qIdx]++];

    if (this.analysisHeads[qIdx] > 256 && this.analysisHeads[qIdx] > queue.length / 2) {
      this.analysisQueues[qIdx] = queue.slice(this.analysisHeads[qIdx]);
      this.analysisHeads[qIdx] = 0;
    }

    const state = this.scopes.get(item.scopeKey);
    if (!state || item.generation !== state.generation) return false;

    const session = state.sessions[qIdx];
    const block = state.blockMap.get(item.blockId);
    if (!block) return false;

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

  // ── Transform processing ────────────────────────────────────────────────

  private processTransform(changed: Set<StmtNS.FileInput | StmtNS.FunctionDef>): boolean {
    let idx = this.transformHead;
    while (idx < this.transformQueue.length && this.activeScopes.has(this.transformQueue[idx].scopeKey)) {
      idx++;
    }
    if (idx >= this.transformQueue.length) return false;

    const item = this.transformQueue[idx];
    if (idx === this.transformHead) this.transformHead++;
    else this.transformQueue.splice(idx, 1);

    if (this.transformHead > 64 && this.transformHead > this.transformQueue.length / 2) {
      this.transformQueue.splice(0, this.transformHead);
      this.transformHead = 0;
    }

    const state = this.scopes.get(item.scopeKey);
    if (!state || item.generation !== state.generation) return false;

    let anyChanged = false;
    for (const rule of this.transforms) {
      anyChanged = applyTransformPass(state.unit.body, rule, state.unit.hints) || anyChanged;
    }

    if (anyChanged) {
      this._transformRounds++;
      state.unit.structuralVersion++;
      changed.add(item.scopeKey);
      this.rebuildAndReseed(item.scopeKey, state);
    }

    return true;
  }

  // ── Seeding ──────────────────────────────────────────────────────────────

  private rebuildAndReseed(key: StmtNS.FileInput | StmtNS.FunctionDef, state: ScopeWorkState): void {
    state.generation++;
    state.cfg = buildCFG(state.unit.body);
    state.blockMap.clear();
    for (const block of state.cfg.blocks) state.blockMap.set(block.id, block);
    state.sessions = this.analyses.map(m => makeSession(m, state.cfg));

    this.seedAnalysis(key, state);
    this.enqueueTransform(key, state.generation);
  }

  private seedAnalysis(key: StmtNS.FileInput | StmtNS.FunctionDef, state: ScopeWorkState): void {
    for (let i = 0; i < this.analyses.length; i++) {
      const direction = this.analyses[i].direction;
      const seed = seedBlock(state.cfg, direction);
      this.enqueueAnalysisBlock(i, key, seed.id, state.generation);
    }
  }

  // No dedup: the convergence check (outEnv.equals) short-circuits repeats.
  private enqueueAnalysisBlock(
    qIdx: number,
    scopeKey: StmtNS.FileInput | StmtNS.FunctionDef,
    blockId: BlockId,
    generation: number,
  ): void {
    this.analysisQueues[qIdx].push({ scopeKey, blockId, generation });
  }

  private enqueueTransform(scopeKey: StmtNS.FileInput | StmtNS.FunctionDef, generation: number): void {
    this.transformQueue.push({ scopeKey, generation });
  }

  private notify(changed: ReadonlySet<StmtNS.FileInput | StmtNS.FunctionDef>): void {
    if (changed.size === 0) return;
    for (const cb of this.subscribers) cb(changed);
  }
}
