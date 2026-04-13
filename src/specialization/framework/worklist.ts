// src/specialization/framework/worklist.ts — unified priority-scheduled worklist
//
// Two-tier priority: analysis blocks process before transforms. Within analysis,
// earlier modules (e.g. type before const) complete before later ones, so
// transforms only fire at local fixpoint.
//
// This file hosts both the CFG-based Kildall DFA primitives (direction
// helpers, IN-merge, block transfer) and the scheduler class that drives
// them. The class also acts as the push-side for runtime observations and
// the publish-side for reactive consumers: construct with (ast,
// environments, analyses, transforms), then call `converge()`, `tick()`,
// `observeWrite()`, `subscribe()`.

import { Queue } from "@datastructures-js/queue";

import { ExprNS, StmtNS } from "../../ast-types";
import type { FunctionEnvironments } from "../../resolver";
import type { BasicBlock, BlockId, CFG } from "./cfg";
import { buildCFG } from "./cfg";
import { buildFunctionUnits, makeOut, type FunctionUnit } from "./function-unit";
import type { FieldEquals, HintStore, OptimizationHint } from "./hint";
import type { AnalysisPass, ScopePass, TransformRule } from "./interfaces";
import { MutableEnv } from "./mutable-env";
import type { ObservationSink } from "./observation-sink";
import type { SlotLookup } from "./slot-table";
import { applyTransformPass } from "./transform";

// ── Direction helpers ───────────────────────────────────────────────────────

/** Blocks whose OUTs feed into this block's IN (predecessors for forward, successors for backward). */
function incomingBlocks(block: BasicBlock, direction: "forward" | "backward"): BasicBlock[] {
  return direction === "forward" ? block.predecessors : block.successors;
}

/** Blocks to propagate to when this block's OUT changes (successors for forward, predecessors for backward). */
export function outgoingBlocks(block: BasicBlock, direction: "forward" | "backward"): BasicBlock[] {
  return direction === "forward" ? block.successors : block.predecessors;
}

/** The seed block: entry for forward, exit for backward. */
export function seedBlock(cfg: CFG, direction: "forward" | "backward"): BasicBlock {
  return direction === "forward" ? cfg.entry : cfg.exit;
}

/** The sentinel block that should never be transferred: exit for forward, entry for backward. */
export function sentinelBlock(cfg: CFG, direction: "forward" | "backward"): BasicBlock {
  return direction === "forward" ? cfg.exit : cfg.entry;
}

// ── Merge ───────────────────────────────────────────────────────────────────

/**
 * Merge one incoming OUT into the accumulator.
 *
 * - may-analysis: uses join (incoming missing slots = ⊥, identity for join)
 * - must-analysis: uses meet (incoming missing slots = ⊤, identity for meet)
 */
export function mergeInto<L>(
  acc: MutableEnv<L>,
  incoming: MutableEnv<L>,
  module: AnalysisPass<L>,
): void {
  if (module.mergeKind === "must") {
    acc.meetWith(incoming, module.meet.bind(module), module.top());
  } else {
    acc.joinWith(incoming, module.join.bind(module));
  }
}

/**
 * Compute the IN environment for `block` by merging incoming block OUTs.
 * Incoming blocks with `null` OUT (never processed) are skipped.
 */
export function computeBlockIN<L>(
  block: BasicBlock,
  module: AnalysisPass<L>,
  out: Map<BlockId, MutableEnv<L> | null>,
): MutableEnv<L> {
  let result: MutableEnv<L> | null = null;
  for (const inc of incomingBlocks(block, module.direction)) {
    const incOut = out.get(inc.id) ?? null;
    if (incOut === null) continue; // never processed — skip
    if (result === null) {
      result = incOut.snapshot();
    } else {
      mergeInto(result, incOut, module);
    }
  }
  return result ?? new MutableEnv<L>();
}

// ── Transfer ─────────────────────────────────────────────────────────────────

/**
 * Transfer one statement, updating `env` in place.
 *
 * Control-flow statements (If, While, For) appear as header stmts in their
 * blocks. Only the condition/iter expression is evaluated here — the body
 * is in successor blocks and handled by the worklist.
 */
function transferStmt<L>(
  stmt: StmtNS.Stmt,
  env: MutableEnv<L>,
  visitor: ExprNS.Visitor<L>,
  module: AnalysisPass<L>,
  slotLookup: SlotLookup,
): void {
  switch (stmt.kind) {
    case "Assign": {
      const assign = stmt as StmtNS.Assign;
      const val = assign.value.accept(visitor);
      if (!(assign.target instanceof ExprNS.Variable)) break;
      const info = slotLookup(assign.target.name);
      if (!info.isPrimitive && info.envLevel === 0) {
        env.set(info.slot, val);
      }
      break;
    }

    case "AnnAssign": {
      const ann = stmt as StmtNS.AnnAssign;
      const val = ann.value.accept(visitor);
      const info = slotLookup(ann.target.name);
      if (!info.isPrimitive && info.envLevel === 0) {
        env.set(info.slot, val);
      }
      break;
    }

    // Loop headers: evaluate condition/iter. For targets get top().
    case "If": {
      const ifStmt = stmt as StmtNS.If;
      ifStmt.condition.accept(visitor);
      break;
    }

    case "While": {
      const whileStmt = stmt as StmtNS.While;
      whileStmt.condition.accept(visitor);
      break;
    }

    case "For": {
      const forStmt = stmt as StmtNS.For;
      forStmt.iter.accept(visitor);
      // Iterator target: type is unknown across iterations → top()
      const info = slotLookup(forStmt.target);
      if (!info.isPrimitive && info.envLevel === 0) {
        env.set(info.slot, module.top());
      }
      break;
    }

    case "Return": {
      const ret = stmt as StmtNS.Return;
      if (ret.value) ret.value.accept(visitor);
      break;
    }

    case "SimpleExpr": {
      const se = stmt as StmtNS.SimpleExpr;
      se.expression.accept(visitor);
      break;
    }

    case "Assert": {
      const assert = stmt as StmtNS.Assert;
      assert.value.accept(visitor);
      break;
    }

    // No-ops: no data flow effect.
    case "FunctionDef":
    case "Pass":
    case "Break":
    case "Continue":
    case "Global":
    case "NonLocal":
    case "FromImport":
      break;

    // FileInput should not appear inside a basic block.
    case "FileInput":
      break;
  }
}

/**
 * Transfer all statements in a block, producing the OUT environment.
 *
 * Forward analysis processes statements top-to-bottom.
 * Backward analysis processes statements bottom-to-top.
 */
export function transferBlock<L>(
  block: BasicBlock,
  inEnv: MutableEnv<L>,
  module: AnalysisPass<L>,
  hints: HintStore,
  slotLookup: SlotLookup,
): MutableEnv<L> {
  const env = inEnv.snapshot(); // OUT starts as a copy of IN
  const visitor = module.makeExprVisitor(hints, env, slotLookup);
  const stmts = block.stmts;
  if (module.direction === "backward") {
    for (let i = stmts.length - 1; i >= 0; i--) {
      transferStmt(stmts[i], env, visitor, module, slotLookup);
    }
  } else {
    for (const stmt of stmts) {
      transferStmt(stmt, env, visitor, module, slotLookup);
    }
  }
  return env;
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

// ── Performance stats ───────────────────────────────────────────────────────

export interface WorklistStats {
  readonly itemsProcessed: number;
  readonly analysisItemsProcessed: number;
  readonly transformItemsProcessed: number;
  readonly transformRounds: number;
  readonly drainCalls: number;
  readonly wallClockMs: number;
  /** Structural rebuilds: CFG rebuilt and generation bumped. */
  readonly cfgBuilds: number;
  /** Data-only reseeds: analysisOuts cleared and queues reseeded, CFG reused. */
  readonly dataReseeds: number;
}

/**
 * Invalidation reason on the internal dirty channel. `structural` dominates
 * `data` on merge: if a scope is marked `data` and later `structural` (or
 * vice versa) before the next drain flushes, the stronger reason wins.
 */
type DirtyReason = "data" | "structural";

// ── Subscribers ─────────────────────────────────────────────────────────────

export type Subscriber = (changed: ReadonlySet<StmtNS.FileInput | StmtNS.FunctionDef>) => void;

/** Listener for `onScopeChanged`. */
export type ScopeChangeListener = (
  scope: StmtNS.FileInput | StmtNS.FunctionDef,
  unit: FunctionUnit,
) => void;

// ── Push-side interface ─────────────────────────────────────────────────────
//
// `ObservationSink` is the nominal synchronous surface interpreters call on
// the worklist during execution; see `./observation-sink.ts`. `Worklist
// implements ObservationSink` below. Synchrony is enforced in-constructor
// (see the `AsyncFunction` check at the bottom of the Worklist
// constructor) because TypeScript accepts `() => Promise<void>` where
// `() => void` is expected.

export type { ObservationSink } from "./observation-sink";

// ── Observation-capable analysis (narrowed subtype) ────────────────────────

type ObservingAnalysis = AnalysisPass<any> & {
  observeWrite: NonNullable<AnalysisPass<any>["observeWrite"]>;
};

// ── Worklist ────────────────────────────────────────────────────────────────

export class Worklist implements ObservationSink {
  readonly units: ReadonlyMap<StmtNS.FileInput | StmtNS.FunctionDef, FunctionUnit>;
  private readonly analysisQueues: Queue<QueuedBlock>[];
  private readonly transformQueue = new Queue<QueuedTransform>();

  private readonly subscribers = new Set<Subscriber>();

  /**
   * Pre-filtered subset of `analyses` that implement the runtime-observation
   * hook. Observation handling iterates this list rather than re-checking
   * `observeWrite` on every analysis per write. The type narrows the hook to
   * required so the loop body needs no non-null asserts.
   */
  private readonly observers: readonly ObservingAnalysis[];

/**
   * Cached at construction: true iff any transform is a non-monotone scope
   * rule (fireOnce), meaning a runtime call observation can newly enable it
   * and a mid-execution tick is worth the drain cost. For purely monotone
   * configurations the tick is redundant and skipped.
   */
  private readonly hasNonMonotoneRule: boolean;

  /**
   * Internal per-scope dirty channel. `observeWrite`, `observeCall`, transform
   * completion, and cross-scope invalidation all publish here; `drain` flushes
   * at the top of each iteration. One idiom, nested inside the external
   * `onScopeChanged` subscriber contract.
   */
  private readonly dirty = new Map<StmtNS.FileInput | StmtNS.FunctionDef, DirtyReason>();

  /**
   * Fields written by any registered `ScopePass.writesFields`. AnalysisPass
   * transfers MUST NOT read these — the ordering invariant is that
   * scope-level facts flow to `ScopeTransformRule.matches` (same round) and
   * later ScopePasses, never back into expression-level DFA. Enforced at
   * runtime in dev builds via `guardAnalysisHints`.
   */
  private readonly forbiddenScopeFields: ReadonlySet<string>;

  // Perf counters
  private _itemsProcessed = 0;
  private _analysisItemsProcessed = 0;
  private _transformItemsProcessed = 0;
  private _transformRounds = 0;
  private _drainCalls = 0;
  private _wallClockMs = 0;
  private _cfgBuilds = 0;
  private _dataReseeds = 0;

  constructor(
    ast: StmtNS.FileInput,
    functionEnvironments: FunctionEnvironments,
    private readonly analyses: readonly AnalysisPass<any>[],
    private readonly transforms: readonly TransformRule[],
    private readonly scopePasses: readonly ScopePass[] = [],
  ) {
    this.analysisQueues = analyses.map(() => new Queue<QueuedBlock>());
    this.observers = analyses.filter(
      (m): m is ObservingAnalysis => m.observeWrite !== undefined,
    );
    this.hasNonMonotoneRule = transforms.some(r => r.level === "scope" && r.fireOnce === true);

    // Per-field equality: each AnalysisPass registers latticeEquals under its name.
    const fieldEq = new Map<string, FieldEquals>();
    for (const a of analyses) {
      fieldEq.set(a.name, (x, y) => a.latticeEquals(x, y));
    }

    // Ordering-invariant guard: every field written by a ScopePass must NOT
    // be read inside an AnalysisPass transfer (see `processTransform`
    // ordering comment). Collected once at construction; used by
    // `guardAnalysisHints` below.
    const forbidden = new Set<string>();
    for (const p of scopePasses) {
      if (p.writesFields) for (const f of p.writesFields) forbidden.add(f);
    }
    this.forbiddenScopeFields = forbidden;

    this.units = buildFunctionUnits(ast, functionEnvironments, analyses, fieldEq);
    for (const [key, unit] of this.units) {
      this.seedAnalysis(key, unit);
      this.enqueueTransform(key, unit.generation);
    }

    // Synchrony tripwire — TS accepts `() => Promise<void>` where `() => void`
    // is declared. Catch the `async`-declared case at construction rather than
    // at first observation. `satisfies` checks each entry is a valid key of
    // ObservationSink; completeness is maintained by hand.
    const SINK_METHODS = [
      "observeWrite",
      "observeCall",
    ] as const satisfies readonly (keyof ObservationSink)[];
    for (const name of SINK_METHODS) {
      const fn = (this as unknown as Record<string, unknown>)[name];
      if (typeof fn !== "function") {
        throw new Error(`ObservationSink.${name} was replaced with a non-function value`);
      }
      if ((fn as { constructor?: { name?: string } }).constructor?.name === "AsyncFunction") {
        throw new Error(`ObservationSink.${name} must be synchronous`);
      }
    }
  }

  // ── Reactive API ───────────────────────────────────────────────────────

  /** Drain to fixpoint (initial pass). */
  converge(): void {
    this.notify(this.drain());
  }

  /**
   * Process pending work incrementally. Returns true if any units changed.
   *
   * Evaluators call `tick()` after execution completes to drain any work
   * queued during the run. External callers (tests, advanced consumers
   * driving the reactive loop manually) may invoke it directly; the return
   * value is a drain-progress signal for those flows.
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
   * Invoked once per scope whose AST was mutated during the last `tick()`.
   * Returns an unsubscribe closure.
   */
  onScopeChanged(cb: ScopeChangeListener): () => void {
    const wrapped: Subscriber = changed => {
      for (const key of changed) {
        const unit = this.units.get(key);
        if (unit) cb(key, unit);
      }
    };
    return this.subscribe(wrapped);
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

  observeWrite(
    scopeKey: StmtNS.FileInput | StmtNS.FunctionDef,
    rhsNode: ExprNS.Expr,
    rawValue: unknown,
  ): void {
    const unit = this.units.get(scopeKey);
    if (!unit) return;
    const hints = unit.hints;
    let next = hints.getById(rhsNode.id) ?? {};
    for (const observer of this.observers) {
      next = observer.observeWrite(next, rawValue);
    }
    hints.setById(rhsNode.id, next);
    this.markDirty(scopeKey, "data");
  }

  observeCall(
    scopeKey: StmtNS.FileInput | StmtNS.FunctionDef,
    calleeKey: StmtNS.FileInput | StmtNS.FunctionDef,
  ): void {
    const calleeUnit = this.units.get(calleeKey);
    if (!calleeUnit) return;
    calleeUnit.callObservations.push({ callerKey: scopeKey, calleeKey });
    this.markDirty(calleeKey, "data");
    // Tick so any newly-enabled non-monotone transforms (e.g. memoization
    // crossing its call-count threshold) fire *during* execution. Safe
    // under the LBD contract: interpreters re-resolve function bodies at
    // call-entry, so mutations land on the next call. Skipped for purely
    // monotone configurations where no call-count threshold can flip.
    if (this.hasNonMonotoneRule) this.tick();
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
      // Flush dirty channel first: convert pending invalidation marks into
      // queue state before selecting an item. Structural flushes rebuild the
      // CFG; data flushes reuse it. If flush mutated any queue, reset the
      // stall baseline — new items added by flush are progress, not stalls.
      const shapeBeforeFlush = this.queueShape();
      this.flushDirty();
      const shapeAfterFlush = this.queueShape();
      if (shapeAfterFlush !== shapeBeforeFlush) {
        stallWindow = 0;
        lastQueueShape = shapeAfterFlush;
      }

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
            `[Worklist] drain stalled: findActiveQueue returned ${qIdx} but no queue advanced across two iterations. ` +
              `queueShape=${shape} pending=${this.pending}`,
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
    let s = `${this.transformQueue.size()}`;
    for (let i = 0; i < this.analysisQueues.length; i++) {
      s += `|${this.analysisQueues[i].size()}`;
    }
    return s;
  }

  get idle(): boolean {
    return this.findActiveQueue() === -1;
  }

  get pending(): number {
    let n = this.transformQueue.size();
    for (const q of this.analysisQueues) n += q.size();
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
      cfgBuilds: this._cfgBuilds,
      dataReseeds: this._dataReseeds,
    });
  }

  resetStats(): void {
    this._itemsProcessed = 0;
    this._analysisItemsProcessed = 0;
    this._transformItemsProcessed = 0;
    this._transformRounds = 0;
    this._drainCalls = 0;
    this._wallClockMs = 0;
    this._cfgBuilds = 0;
    this._dataReseeds = 0;
  }

  // ── Queue selection ─────────────────────────────────────────────────────

  private findActiveQueue(): number {
    for (let i = 0; i < this.analysisQueues.length; i++) {
      if (!this.analysisQueues[i].isEmpty()) return i;
    }
    if (!this.transformQueue.isEmpty()) return this.analyses.length;
    return -1;
  }

  // ── Analysis processing ─────────────────────────────────────────────────

  private processAnalysisBlock(
    qIdx: number,
    changed: Set<StmtNS.FileInput | StmtNS.FunctionDef>,
  ): boolean {
    const item = this.analysisQueues[qIdx].dequeue();
    if (item === null) return false;

    const unit = this.units.get(item.scopeKey);
    if (!unit || item.generation !== unit.generation) return false;

    const module = this.analyses[qIdx];
    const out = unit.analysisOuts[qIdx];
    const block = unit.blockMap.get(item.blockId);
    if (!block) return false;

    const inEnv = computeBlockIN(block, module, out);
    const hintsForTransfer = this.guardAnalysisHints(unit.hints, module.name);
    const outEnv = transferBlock(block, inEnv, module, hintsForTransfer, unit.slotLookup);

    const prevOut = out.get(block.id) ?? null;
    if (prevOut === null || !outEnv.equals(prevOut, module.leq.bind(module))) {
      out.set(block.id, outEnv);
      changed.add(item.scopeKey);

      const sentinel = sentinelBlock(unit.cfg, module.direction);
      for (const next of outgoingBlocks(block, module.direction)) {
        if (next !== sentinel) {
          this.enqueueAnalysisBlock(qIdx, item.scopeKey, next.id, unit.generation);
        }
      }
    }

    return true;
  }

  // ── Transform processing ────────────────────────────────────────────────

  private processTransform(changed: Set<StmtNS.FileInput | StmtNS.FunctionDef>): boolean {
    const item = this.transformQueue.dequeue();
    if (item === null) return false;

    const unit = this.units.get(item.scopeKey);
    if (!unit || item.generation !== unit.generation) return false;

    // Scope-level passes run once per scope per generation, after the
    // expression-level fixpoint has converged (lower-priority queue
    // guarantees all analysis queues are empty at this point) and before
    // transform rules read scope-level hints.
    //
    // **Ordering invariant:** hint fields written by a ScopePass must
    // only be consumed by `ScopeTransformRule.matches` (same round) or by
    // later ScopePasses (same round). They MUST NOT be read inside any
    // `AnalysisPass.makeExprVisitor` transfer function — that analysis
    // fires earlier in the queue priority order, on the prior generation,
    // and would see stale scope-level facts. Fields that need to feed
    // back into expression-level analyses belong on an `AnalysisPass`
    // (which participates in the fixpoint), not a ScopePass.
    for (const pass of this.scopePasses) {
      pass.run(unit);
    }

    let anyChanged = false;
    const extraInvalidate = new Set<StmtNS.FileInput | StmtNS.FunctionDef>();
    for (const rule of this.transforms) {
      if (rule.level === "scope") {
        // One-shot rules: skip once they've fired successfully on this scope.
        // `appliedTransforms` is the single source of truth — populated by
        // `apply` (the rule itself calls `unit.appliedTransforms.add(this.name)`),
        // read here as the re-fire guard.
        if (rule.fireOnce && unit.appliedTransforms.has(rule.name)) continue;
        if (rule.matches(unit) && rule.apply(unit)) {
          anyChanged = true;
        }
        continue;
      }
      const res = applyTransformPass(unit.body, rule, unit.hints);
      if (res.changed) anyChanged = true;
      for (const s of res.invalidate) extraInvalidate.add(s);
    }

    if (anyChanged) {
      this._transformRounds++;
      unit.structuralVersion++;
      changed.add(item.scopeKey);
      this.markDirty(item.scopeKey, "structural");
    }
    // Rule-requested invalidations (e.g. memoization mutated a child
    // FunctionDef's body from the parent pass): publish to the same dirty
    // channel as the originating scope's own mark. No dedicated code path —
    // the child's CFG rebuild happens uniformly on the next drain iteration.
    for (const scope of extraInvalidate) {
      if (scope === item.scopeKey) continue;
      const childUnit = this.units.get(scope);
      if (childUnit) {
        childUnit.structuralVersion++;
        changed.add(scope);
        this.markDirty(scope, "structural");
      }
    }

    return true;
  }

  // ── Seeding ──────────────────────────────────────────────────────────────

  /**
   * Opt-in guard: wrap `hints` so that an AnalysisPass transfer reading a
   * field declared by some `ScopePass.writesFields` throws. Disabled by
   * default — the Proxy incurs V8 interceptor overhead on every read and
   * bloats the DFA hot path. Enable by setting
   * `PY_SLANG_GUARD_SCOPE_FIELDS=1` when investigating an ordering
   * invariant violation.
   *
   * Scope: only wraps the `get` / `getById` read paths. Writes are not
   * guarded (the invariant is about *reads* from AnalysisPass visitors).
   */
  private guardAnalysisHints(hints: HintStore, moduleName: string): HintStore {
    if (this.forbiddenScopeFields.size === 0) return hints;
    if (typeof process === "undefined" || process.env?.PY_SLANG_GUARD_SCOPE_FIELDS !== "1") {
      return hints;
    }
    const forbidden = this.forbiddenScopeFields;
    const wrap = (h: OptimizationHint | undefined): OptimizationHint | undefined => {
      if (h === undefined) return undefined;
      return new Proxy(h, {
        get(target, prop: string | symbol) {
          if (typeof prop === "string" && forbidden.has(prop)) {
            throw new Error(
              `[Worklist] AnalysisPass "${moduleName}" read forbidden scope-level hint field "${prop}". ` +
                `Scope-level facts flow to ScopeTransformRule / later ScopePasses, not back into expression-level DFA.`,
            );
          }
          return Reflect.get(target, prop);
        },
      });
    };
    return new Proxy(hints, {
      get(target, prop, receiver) {
        if (prop === "get") {
          return (node: ExprNS.Expr | StmtNS.Stmt) => wrap(target.get(node));
        }
        if (prop === "getById") {
          return (id: number) => wrap(target.getById(id));
        }
        return Reflect.get(target, prop, receiver);
      },
    });
  }

  /**
   * Publish to the internal dirty channel. Idempotent per scope;
   * `structural` dominates `data` if both are marked before the next flush.
   */
  private markDirty(
    key: StmtNS.FileInput | StmtNS.FunctionDef,
    reason: DirtyReason,
  ): void {
    if (this.dirty.get(key) === "structural") return;
    this.dirty.set(key, reason);
  }

  /**
   * Consume all pending dirty entries. Called at the top of each `drain`
   * iteration so that `findActiveQueue` sees up-to-date queue state.
   */
  private flushDirty(): void {
    if (this.dirty.size === 0) return;
    for (const [key, reason] of this.dirty) {
      const unit = this.units.get(key);
      if (!unit) continue;
      if (reason === "structural") {
        this.rebuildStructural(key, unit);
      } else {
        this.reseedAnalysis(key, unit);
      }
    }
    this.dirty.clear();
  }

  /**
   * Structural path: the body reference was spliced by a transform (or a
   * cross-scope rewrite). Rebuild the CFG, bump `generation` so any
   * in-flight queue items are dropped, and reseed analysis + transform.
   */
  private rebuildStructural(
    key: StmtNS.FileInput | StmtNS.FunctionDef,
    unit: FunctionUnit,
  ): void {
    this._cfgBuilds++;
    unit.generation++;
    unit.cfg = buildCFG(unit.body);
    unit.blockMap = new Map<BlockId, BasicBlock>();
    for (const block of unit.cfg.blocks) unit.blockMap.set(block.id, block);
    unit.analysisOuts = this.analyses.map(() => makeOut(unit.cfg));

    this.seedAnalysis(key, unit);
    this.enqueueTransform(key, unit.generation);
  }

  /**
   * Data path: hints changed but the body is identical. Skip `buildCFG`
   * (the point of the split); clear `analysisOuts` since transfers read
   * hints; bump `generation` to drop in-flight queued items.
   */
  private reseedAnalysis(
    key: StmtNS.FileInput | StmtNS.FunctionDef,
    unit: FunctionUnit,
  ): void {
    this._dataReseeds++;
    unit.generation++;
    unit.analysisOuts = this.analyses.map(() => makeOut(unit.cfg));
    this.seedAnalysis(key, unit);
    this.enqueueTransform(key, unit.generation);
  }

  private seedAnalysis(key: StmtNS.FileInput | StmtNS.FunctionDef, unit: FunctionUnit): void {
    for (let i = 0; i < this.analyses.length; i++) {
      const direction = this.analyses[i].direction;
      const seed = seedBlock(unit.cfg, direction);
      this.enqueueAnalysisBlock(i, key, seed.id, unit.generation);
    }
  }

  // No dedup: the convergence check (outEnv.equals) short-circuits repeats.
  private enqueueAnalysisBlock(
    qIdx: number,
    scopeKey: StmtNS.FileInput | StmtNS.FunctionDef,
    blockId: BlockId,
    generation: number,
  ): void {
    this.analysisQueues[qIdx].enqueue({ scopeKey, blockId, generation });
  }

  private enqueueTransform(
    scopeKey: StmtNS.FileInput | StmtNS.FunctionDef,
    generation: number,
  ): void {
    this.transformQueue.enqueue({ scopeKey, generation });
  }

  private notify(changed: ReadonlySet<StmtNS.FileInput | StmtNS.FunctionDef>): void {
    if (changed.size === 0) return;
    for (const cb of this.subscribers) cb(changed);
  }
}
