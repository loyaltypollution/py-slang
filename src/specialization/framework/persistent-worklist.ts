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

// ── Queue compaction ────────────────────────────────────────────────────────
//
// Both the analysis and transform queues are FIFOs served via an advancing
// `head` index. When the consumed prefix grows large we drop it to keep
// memory bounded. Unified threshold: compact when `head > 64` *and* the
// dead prefix is more than half the queue — cheap for small queues, bounds
// growth for large ones.

const QUEUE_COMPACT_THRESHOLD = 64;
function compactQueue<T>(queue: T[], head: number): number {
  if (head > QUEUE_COMPACT_THRESHOLD && head > queue.length / 2) {
    queue.splice(0, head);
    return 0;
  }
  return head;
}

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

// ── Push-side interface ─────────────────────────────────────────────────────
//
// The four methods interpreters call on the worklist during execution. Kept
// as a structural alias so interpreter modules document their dependency on
// the observation surface without importing the full scheduler API.
//
// SYNCHRONY INVARIANT: all four methods return `void`, not `Promise<void>`.
// Observation emission is a synchronous sub-call of the interpreter step
// that produced it — `observeWrite`/`observeCall` enqueue work;
// `activateScope`/`deactivateScope` mutate the pin-set in place. The OSR
// safepoint contract (transforms on pinned scopes parked until deactivation)
// rests on this synchrony. TypeScript accepts `() => Promise<void>` where
// `() => void` is expected, so the construction-time check in the
// `PersistentWorklist` constructor catches the common mistake of declaring
// one of these `async`.

export type ObservationSink = Pick<
  PersistentWorklist,
  "observeWrite" | "observeCall" | "activateScope" | "deactivateScope"
>;

const SINK_METHODS = ["observeWrite", "observeCall", "activateScope", "deactivateScope"] as const;

/**
 * Construction-time tripwire that rejects the common mistake of declaring
 * a sink method `async`. Inspects each method's runtime constructor name
 * and throws if it is `AsyncFunction`. Catches `async function`/`async () =>
 * ...` only; explicit `Promise.resolve()` returns and transpiled async are
 * out of scope (the `void` return in `ObservationSink` is the declared
 * contract).
 */
export function assertSyncObservationSink(sink: ObservationSink): void {
  for (const name of SINK_METHODS) {
    const fn = (sink as unknown as Record<string, unknown>)[name];
    if (typeof fn !== "function") {
      throw new Error(`ObservationSink.${name} is not a function`);
    }
    if ((fn as { constructor?: { name?: string } }).constructor?.name === "AsyncFunction") {
      throw new Error(
        `ObservationSink.${name} must be synchronous; async implementations break the OSR safepoint contract`,
      );
    }
  }
}

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
  /**
   * Pin-set: multiset of currently-executing scopes. Source of truth is
   * **external** — engines mutate this via env/frame push/pop (CSE's
   * `pushEnvironment`/`popEnvironment`; SVML's frame push/pop and
   * exception-finally frame walk). Anchoring to the engine's own lifecycle
   * primitive (which must be balanced for correctness-unrelated reasons:
   * scope resolution, return-address management) converts the pin
   * invariant from protocol ("every activate paired with deactivate on
   * every exit path") to data ("pin-count = live-frame-count").
   *
   * The worklist retains `activateScope`/`deactivateScope` methods for
   * the root-scope pinning performed by `withActiveScope`, and for tests
   * that construct a worklist without an interpreter. Both write to this
   * same map.
   */
  private readonly activeScopes: Map<StmtNS.FileInput | StmtNS.FunctionDef, number>;
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
    pinSet?: Map<StmtNS.FileInput | StmtNS.FunctionDef, number>,
  ) {
    this.activeScopes = pinSet ?? new Map();
    this.analysisQueues = analyses.map(() => []);
    this.analysisHeads = analyses.map(() => 0);
    this.observers = analyses.filter(
      (m): m is ObservingAnalysis =>
        m.observeValue !== undefined && m.mergeIntoHint !== undefined,
    );
    this.cacheSafeOnStackFlag();

    const units = buildFunctionUnits(ast, functionEnvironments);
    this.units = units;
    for (const [key, unit] of units) this.addScope(key, unit);

    assertSyncObservationSink(this);
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

  /**
   * Process pending work incrementally. Returns true if any units changed.
   *
   * In production, tick is invoked automatically at the end of each
   * `withActiveScope` via `deactivateAndTick`. External callers (tests,
   * advanced consumers driving the reactive loop manually) may invoke it
   * directly; the return value is a drain-progress signal for those flows.
   */
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
        if (!calleeState) return;
        for (const mod of this.analyses) {
          mod.onCallObservation?.(item.scopeKey, item.calleeKey, calleeState.unit.hints);
        }
        this.rebuildAndReseed(item.calleeKey, calleeState);
        // Tick once so any newly-enabled safeOnStack transforms (e.g.
        // memoization crossing its call-count threshold) fire *during*
        // execution. Without this, a recursive workload like fib(20) stays
        // pinned to completion and the transform runs only after the program
        // exits — too late to help the current run.
        if (this.hasSafeOnStackScopeRule) this.tick();
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
    // Bounded-progress guard. `findActiveQueue` returning != -1 must
    // coincide with at least one process*() call succeeding; otherwise
    // drain() spins forever (the exact livelock the pin-set refactor is
    // designed to prevent). We track queue fingerprints across iterations
    // and throw on stall — converts a silent 99% CPU hang into a loud
    // failure pointing at the diverging predicate.
    let stallWindow = 0;
    let lastQueueShape = this.queueShape();

    while (processed < limit) {
      const qIdx = this.findActiveQueue();
      if (qIdx === -1) break;

      let madeProgress = false;
      if (qIdx < this.analyses.length) {
        if (this.processAnalysisBlock(qIdx, changed)) {
          processed++;
          this._itemsProcessed++;
          this._analysisItemsProcessed++;
          madeProgress = true;
        }
      } else {
        if (this.processTransform(changed)) {
          processed++;
          this._itemsProcessed++;
          this._transformItemsProcessed++;
          madeProgress = true;
        }
      }

      if (madeProgress) {
        stallWindow = 0;
        lastQueueShape = this.queueShape();
        continue;
      }

      // findActiveQueue claimed work but the process*() refused. A single
      // stall can still be legitimate progress (item popped, generation
      // mismatch → returned false but queue shrank). Compare shape; if
      // the queues didn't change either, this is a genuine stall.
      const shape = this.queueShape();
      if (shape === lastQueueShape) {
        stallWindow++;
        if (stallWindow >= 2) {
          throw new Error(
            `[PersistentWorklist] drain stalled: findActiveQueue returned ${qIdx} but no queue advanced across two iterations. ` +
              `queueShape=${shape} pending=${this.pending} activeScopes=${this.activeScopes.size}`,
          );
        }
      } else {
        stallWindow = 0;
        lastQueueShape = shape;
      }
    }

    this._wallClockMs += performance.now() - t0;
    return changed;
  }

  /**
   * Cheap fingerprint of queue state — enough to detect non-progress
   * across drain iterations. Changes whenever any queue advances or any
   * item is removed.
   */
  private queueShape(): string {
    let s = `${this.transformHead}/${this.transformQueue.length}`;
    for (let i = 0; i < this.analysisQueues.length; i++) {
      s += `|${this.analysisHeads[i]}/${this.analysisQueues[i].length}`;
    }
    return s;
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

  private hasSafeOnStackScopeRule = false;
  private cacheSafeOnStackFlag(): void {
    this.hasSafeOnStackScopeRule = this.transforms.some(
      r => r.level === "scope" && r.safeOnStack === true,
    );
  }

  /**
   * Single source of truth for "is this transform item runnable right now?"
   * Both `hasProcessableTransform` (queue-existence check for drain
   * scheduling) and `processTransform` (item acceptance in drain) consult
   * this predicate. Drift between the two was the root of a prior livelock
   * where `hasProcessableTransform` said yes on a stale pinned item and
   * `processTransform` then refused to advance past it.
   */
  private isTransformProcessable(item: QueuedTransform): boolean {
    if (!this.activeScopes.has(item.scopeKey)) return true;
    return this.hasSafeOnStackScopeRule;
  }

  private hasProcessableTransform(): boolean {
    for (let i = this.transformHead; i < this.transformQueue.length; i++) {
      if (this.isTransformProcessable(this.transformQueue[i])) return true;
    }
    return false;
  }

  // ── Analysis processing ─────────────────────────────────────────────────

  private processAnalysisBlock(qIdx: number, changed: Set<StmtNS.FileInput | StmtNS.FunctionDef>): boolean {
    const queue = this.analysisQueues[qIdx];
    const item = queue[this.analysisHeads[qIdx]++];

    this.analysisHeads[qIdx] = compactQueue(queue, this.analysisHeads[qIdx]);

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
    // Skip items that `isTransformProcessable` rejects so they stay in
    // the queue until the pin releases. Using the shared predicate keeps
    // this in lock-step with `hasProcessableTransform` — any future
    // acceptance-rule change lands in one place.
    let idx = this.transformHead;
    while (idx < this.transformQueue.length && !this.isTransformProcessable(this.transformQueue[idx])) {
      idx++;
    }
    if (idx >= this.transformQueue.length) return false;

    const item = this.transformQueue[idx];
    if (idx === this.transformHead) this.transformHead++;
    else this.transformQueue.splice(idx, 1);

    this.transformHead = compactQueue(this.transformQueue, this.transformHead);

    const state = this.scopes.get(item.scopeKey);
    if (!state || item.generation !== state.generation) return false;

    const pinned = this.activeScopes.has(item.scopeKey);
    let anyChanged = false;
    const extraInvalidate = new Set<StmtNS.FileInput | StmtNS.FunctionDef>();
    for (const rule of this.transforms) {
      if (rule.level === "scope") {
        // Pinned scope: only rules that opt in via safeOnStack. Non-safe
        // rules (e.g. full-body rewrites that could race with on-stack
        // frames) stay parked until the pin releases.
        if (pinned && !rule.safeOnStack) continue;
        if (rule.matches(state.unit) && rule.apply(state.unit)) anyChanged = true;
        continue;
      }
      // Expr/stmt rules on pinned scopes are unsafe in general (they can
      // rewrite expressions on the current control stack), so defer.
      if (pinned) continue;
      const res = applyTransformPass(state.unit.body, rule, state.unit.hints);
      if (res.changed) anyChanged = true;
      for (const s of res.invalidate) extraInvalidate.add(s);
    }

    if (anyChanged) {
      this._transformRounds++;
      state.unit.structuralVersion++;
      changed.add(item.scopeKey);
      this.rebuildAndReseed(item.scopeKey, state);
    }
    // Rule-requested invalidations (e.g. memoization mutated a child
    // FunctionDef's body from the parent pass) run even if the local body
    // array wasn't spliced — the body list of the parent stays the same
    // reference, but the child's CFG needs a rebuild.
    for (const scope of extraInvalidate) {
      if (scope === item.scopeKey) continue;
      const childState = this.scopes.get(scope);
      if (childState) {
        childState.unit.structuralVersion++;
        changed.add(scope);
        this.rebuildAndReseed(scope, childState);
      }
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
