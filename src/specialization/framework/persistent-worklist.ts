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
import { hintEquals, type OptimizationHint } from "./hint";
import type { ObservationSink } from "./observation-sink";
import type {
  AnalysisModule,
  CallObserver,
  ScopeTransformRule,
  TransformRule,
} from "./interfaces";
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
// `ObservationSink` is the nominal synchronous surface interpreters call on
// the worklist during execution; see `./observation-sink.ts`. `PersistentWorklist
// implements ObservationSink` below. Synchrony is enforced in-constructor
// (see the `AsyncFunction` check at the bottom of the PersistentWorklist
// constructor) because TypeScript accepts `() => Promise<void>` where
// `() => void` is expected.

export type { ObservationSink } from "./observation-sink";

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

export class PersistentWorklist implements ObservationSink {
  readonly units: ReadonlyMap<StmtNS.FileInput | StmtNS.FunctionDef, FunctionUnit>;
  private readonly analysesByName: ReadonlyMap<string, AnalysisModule<any>>;

  private readonly analysisQueues: QueuedBlock[][];
  private readonly analysisHeads: number[];
  private readonly transformQueue: QueuedTransform[] = [];
  private transformHead = 0;

  private readonly scopes = new Map<StmtNS.FileInput | StmtNS.FunctionDef, ScopeWorkState>();
  /**
   * Pin-set lives on `FunctionUnit.pinCount` (accessed via `this.scopes`).
   * Engines mutate only through `activateScope`/`deactivateScope` on the
   * `ObservationSink` surface — CSE's `pushEnvironment`/`popEnvironment`
   * and SVML's frame push/pop call these. Anchoring to the engine's own
   * lifecycle primitive (which must be balanced for correctness-unrelated
   * reasons: scope resolution, return-address management) converts the
   * pin invariant from protocol ("every activate paired with deactivate
   * on every exit path") to data ("pin-count = live-frame-count").
   */
  private readonly subscribers = new Set<Subscriber>();

  /**
   * Pre-filtered subset of `analyses` that implement the runtime-observation
   * hooks. Observation handling iterates this list rather than re-checking
   * `observeValue` / `mergeIntoHint` on every analysis per write. The type
   * narrows both hooks to required so the loop body needs no non-null asserts.
   */
  private readonly observers: readonly ObservingAnalysis[];

  /**
   * Runtime call-site observers. Populated via `addCallObserver`. Fires on
   * every `observeCall` dispatch, independently of the analysis lattice
   * path. Used for profile-style facts (e.g. memoization saturating count)
   * that don't belong in a Kildall transfer function.
   */
  private readonly callObservers: CallObserver[] = [];

  /**
   * Records scope-rule (scope × rule) pairs whose `fireOnce` flag is set
   * and have already succeeded once. The scheduler skips matches/apply
   * for any recorded pair. This is what lets non-monotone rules
   * (memoization) live here without self-latching through the hint.
   */
  private readonly firedOneShotRules = new Map<
    StmtNS.FileInput | StmtNS.FunctionDef,
    Set<ScopeTransformRule>
  >();

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
    this.analysesByName = new Map(analyses.map(a => [a.name, a]));
    this.cacheSafeOnStackFlag();

    const hintEq = (a: OptimizationHint, b: OptimizationHint) =>
      hintEquals(a, b, this.analysesByName);
    const units = buildFunctionUnits(ast, functionEnvironments, hintEq);
    this.units = units;
    for (const [key, unit] of units) this.addScope(key, unit);

    // Synchrony tripwire — TS accepts `() => Promise<void>` where `() => void`
    // is declared. The OSR safepoint contract depends on all four sink
    // methods being synchronous; catch the `async`-declared case at
    // construction rather than at first observation.
    const SINK_METHODS = ["observeWrite", "observeCall", "activateScope", "deactivateScope"] as const;
    for (const name of SINK_METHODS) {
      const fn = (this as unknown as Record<string, unknown>)[name];
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
   * `withActiveScope`'s finally block (after `deactivateScope`). External
   * callers (tests, advanced consumers driving the reactive loop manually)
   * may invoke it directly; the return value is a drain-progress signal
   * for those flows.
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
   * Register a profile-style call observer. Fires on every `observeCall`
   * dispatch. Independent of the analysis lattice path — observers receive
   * the callee's `HintStore` and can write counter fields directly.
   */
  addCallObserver(observer: CallObserver): void {
    this.callObservers.push(observer);
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
   *
   * Deactivate MUST precede the tick: the worklist parks transforms for
   * pinned scopes, and the tick is what fires them once the pin releases.
   * Reordering would leave transforms parked for a tick that may never come.
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
      this.deactivateScope(scope);
      if (!threw) this.tick();
    }
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
        for (const obs of this.callObservers) {
          obs.onCallObservation(item.scopeKey, item.calleeKey, calleeState.unit.hints);
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
    const state = this.scopes.get(key);
    if (!state) return;
    state.unit.pinCount++;
  }

  deactivateScope(key: StmtNS.FileInput | StmtNS.FunctionDef): void {
    const state = this.scopes.get(key);
    if (!state || state.unit.pinCount === 0) return;
    state.unit.pinCount--;
    if (state.unit.pinCount > 0) return;
    // Re-enqueue a transform for the now-unpinned scope. While the scope
    // was pinned, `processTransform` continued to accept queue items but
    // the `pinned && !rule.safeOnStack` gate (and the unconditional
    // `pinned → continue` for expr/stmt rules) meant all rules were
    // skipped, `anyChanged` stayed false, `rebuildAndReseed` was never
    // called, and no re-enqueue followed. Without this direct re-enqueue,
    // deactivate + tick would find an empty queue. Duplicate-enqueue is
    // safe: stale-generation items are filtered by the generation check
    // in `processTransform`; current-generation duplicates are no-ops if
    // nothing actually changed.
    this.enqueueTransform(key, state.generation);
  }

  isScopeActive(key: StmtNS.FileInput | StmtNS.FunctionDef): boolean {
    return (this.scopes.get(key)?.unit.pinCount ?? 0) > 0;
  }

  /**
   * Zero every unit's `pinCount`. Called by `runPinned` on throw — CSE
   * does not pop envs during JS-stack unwind, so any FunctionDef envs
   * still on the runtime stack never ran their leave-hook. The next
   * evaluation starts fresh, so reset is simpler than reconstruction.
   */
  clearAllPins(): void {
    for (const state of this.scopes.values()) {
      state.unit.pinCount = 0;
    }
  }

  private countPinnedScopes(): number {
    let n = 0;
    for (const state of this.scopes.values()) if (state.unit.pinCount > 0) n++;
    return n;
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
              `queueShape=${shape} pending=${this.pending} pinnedScopes=${this.countPinnedScopes()}`,
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
    if (!this.isScopeActive(item.scopeKey)) return true;
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

    const pinned = state.unit.pinCount > 0;
    let anyChanged = false;
    const extraInvalidate = new Set<StmtNS.FileInput | StmtNS.FunctionDef>();
    for (const rule of this.transforms) {
      if (rule.level === "scope") {
        // Pinned scope: only rules that opt in via safeOnStack. Non-safe
        // rules (e.g. full-body rewrites that could race with on-stack
        // frames) stay parked until the pin releases.
        if (pinned && !rule.safeOnStack) continue;
        // One-shot rules: skip once they've fired successfully on this scope.
        if (rule.fireOnce && this.firedOneShotRules.get(item.scopeKey)?.has(rule)) continue;
        if (rule.matches(state.unit) && rule.apply(state.unit)) {
          anyChanged = true;
          if (rule.fireOnce) {
            let set = this.firedOneShotRules.get(item.scopeKey);
            if (!set) {
              set = new Set();
              this.firedOneShotRules.set(item.scopeKey, set);
            }
            set.add(rule);
          }
        }
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
