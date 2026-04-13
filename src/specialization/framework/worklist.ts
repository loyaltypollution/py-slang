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
import { hintEquals, type HintStore, type OptimizationHint } from "./hint";
import type { AnalysisModule, ProfileObserver, ScopeTransformRule, TransformRule } from "./interfaces";
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
  module: AnalysisModule<L>,
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
  module: AnalysisModule<L>,
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
  module: AnalysisModule<L>,
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
  module: AnalysisModule<L>,
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
}

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

type ObservingAnalysis = AnalysisModule<any> & {
  observeValue: NonNullable<AnalysisModule<any>["observeValue"]>;
  mergeIntoHint: NonNullable<AnalysisModule<any>["mergeIntoHint"]>;
};

// ── Worklist ────────────────────────────────────────────────────────────────

export class Worklist implements ObservationSink {
  readonly units: ReadonlyMap<StmtNS.FileInput | StmtNS.FunctionDef, FunctionUnit>;
  private readonly analysesByName: ReadonlyMap<string, AnalysisModule<any>>;

  private readonly analysisQueues: Queue<QueuedBlock>[];
  private readonly transformQueue = new Queue<QueuedTransform>();

  private readonly subscribers = new Set<Subscriber>();

  /**
   * Pre-filtered subset of `analyses` that implement the runtime-observation
   * hooks. Observation handling iterates this list rather than re-checking
   * `observeValue` / `mergeIntoHint` on every analysis per write. The type
   * narrows both hooks to required so the loop body needs no non-null asserts.
   */
  private readonly observers: readonly ObservingAnalysis[];

  /**
   * Runtime call-site observers. Populated via `addProfileObserver`. Fires on
   * every `observeCall` dispatch, independently of the analysis lattice
   * path. Used for profile-style facts (e.g. memoization saturating count)
   * that don't belong in a Kildall transfer function.
   */
  private readonly profileObservers: ProfileObserver[] = [];

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

  /**
   * Cached at construction: true iff any transform is a non-monotone scope
   * rule (fireOnce), meaning a runtime call observation can newly enable it
   * and a mid-execution tick is worth the drain cost. For purely monotone
   * configurations the tick is redundant and skipped.
   */
  private readonly hasNonMonotoneRule: boolean;

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
    this.analysisQueues = analyses.map(() => new Queue<QueuedBlock>());
    this.observers = analyses.filter(
      (m): m is ObservingAnalysis => m.observeValue !== undefined && m.mergeIntoHint !== undefined,
    );
    this.analysesByName = new Map(analyses.map(a => [a.name, a]));
    this.hasNonMonotoneRule = transforms.some(
      r => r.level === "scope" && r.fireOnce === true,
    );

    const hintEq = (a: OptimizationHint, b: OptimizationHint) =>
      hintEquals(a, b, this.analysesByName);
    this.units = buildFunctionUnits(ast, functionEnvironments, hintEq, analyses);
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
        throw new Error(
          `ObservationSink.${name} was replaced with a non-function value`,
        );
      }
      if ((fn as { constructor?: { name?: string } }).constructor?.name === "AsyncFunction") {
        throw new Error(
          `ObservationSink.${name} must be synchronous`,
        );
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
   * Register a profile-style call observer. Fires on every `observeCall`
   * dispatch. Independent of the analysis lattice path — observers receive
   * the callee's `HintStore` and can write counter fields directly.
   */
  addProfileObserver(observer: ProfileObserver): void {
    this.profileObservers.push(observer);
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
    for (const { observeValue, mergeIntoHint } of this.observers) {
      const lattice = observeValue(rawValue);
      if (lattice === undefined) continue;
      next = mergeIntoHint(next, lattice);
    }
    if (hints.setById(rhsNode.id, next)) {
      this.rebuildAndReseed(scopeKey, unit);
    }
  }

  observeCall(
    scopeKey: StmtNS.FileInput | StmtNS.FunctionDef,
    calleeKey: StmtNS.FileInput | StmtNS.FunctionDef,
  ): void {
    const calleeUnit = this.units.get(calleeKey);
    if (!calleeUnit) return;
    for (const obs of this.profileObservers) {
      obs.onCallObservation(scopeKey, calleeKey, calleeUnit.hints);
    }
    this.rebuildAndReseed(calleeKey, calleeUnit);
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
    const outEnv = transferBlock(block, inEnv, module, unit.hints, unit.slotLookup);

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

    let anyChanged = false;
    const extraInvalidate = new Set<StmtNS.FileInput | StmtNS.FunctionDef>();
    for (const rule of this.transforms) {
      if (rule.level === "scope") {
        // One-shot rules: skip once they've fired successfully on this scope.
        if (rule.fireOnce && this.firedOneShotRules.get(item.scopeKey)?.has(rule)) continue;
        if (rule.matches(unit) && rule.apply(unit)) {
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
      const res = applyTransformPass(unit.body, rule, unit.hints);
      if (res.changed) anyChanged = true;
      for (const s of res.invalidate) extraInvalidate.add(s);
    }

    if (anyChanged) {
      this._transformRounds++;
      unit.structuralVersion++;
      changed.add(item.scopeKey);
      this.rebuildAndReseed(item.scopeKey, unit);
    }
    // Rule-requested invalidations (e.g. memoization mutated a child
    // FunctionDef's body from the parent pass) run even if the local body
    // array wasn't spliced — the body list of the parent stays the same
    // reference, but the child's CFG needs a rebuild.
    for (const scope of extraInvalidate) {
      if (scope === item.scopeKey) continue;
      const childUnit = this.units.get(scope);
      if (childUnit) {
        childUnit.structuralVersion++;
        changed.add(scope);
        this.rebuildAndReseed(scope, childUnit);
      }
    }

    return true;
  }

  // ── Seeding ──────────────────────────────────────────────────────────────

  private rebuildAndReseed(key: StmtNS.FileInput | StmtNS.FunctionDef, unit: FunctionUnit): void {
    unit.generation++;
    unit.cfg = buildCFG(unit.body);
    unit.blockMap = new Map<BlockId, BasicBlock>();
    for (const block of unit.cfg.blocks) unit.blockMap.set(block.id, block);
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
