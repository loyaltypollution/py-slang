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
import { FactStore, type FactChange } from "./fact-store";
import { buildFunctionUnits, makeOut, type FunctionUnit } from "./function-unit";
import type { FieldEquals, HintStore, OptimizationHint } from "./hint";
import type { AnalysisPass } from "./interfaces";
import { MutableEnv } from "./mutable-env";
import type { ObservationSink } from "./observation-sink";
import type { Pass, PassCtx } from "./pass";
import type { SlotLookup } from "./slot-table";
import { structuralPass } from "./structural-pass";
import { runtimeCallPass, runtimeWritePass } from "./runtime-passes";
import {
  callCountPass,
  constAnalysisPass,
  constantFoldingRule,
  deadBranchRule,
  memoizationRule,
  purityScopePass,
  typeAnalysisPass,
} from "./migrated-passes";

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

  /**
   * Pre-filtered subset of `analyses` that implement the runtime-observation
   * hook. Observation handling iterates this list rather than re-checking
   * `observeWrite` on every analysis per write. The type narrows the hook to
   * required so the loop body needs no non-null asserts.
   */
  private readonly observers: readonly ObservingAnalysis[];

  /**
   * Internal per-scope dirty channel. `observeWrite`, `observeCall`, transform
   * completion, and cross-scope invalidation all publish here; `drain` flushes
   * at the top of each iteration. One idiom, nested inside the external
   * `onScopeChanged` subscriber contract.
   */
  private readonly dirty = new Map<StmtNS.FileInput | StmtNS.FunctionDef, DirtyReason>();

  // ── Pass-graph dispatch (PR-2a) ────────────────────────────────────────
  //
  // Single fact store + subscription graph layered alongside the legacy
  // analysisQueue/transformQueue drain. PR-2a wires `structuralPass` as the
  // sole producer — `rebuildStructural` writes through. Fan-out uses
  // `FactStore.onChange`: on a lattice-change write to pass `p`, every
  // registered pass `p'` whose `reads` contains `p` is enqueued for every
  // key in `p'.affectedKeys?.(p, k)` (or all previously-written keys if
  // `p'.coarse === true`).
  //
  // The legacy dirty/flushDirty/analysis/transform queues are preserved
  // verbatim for existing callers; this layer only serves passes registered
  // through the new `register()` API (no existing caller uses it yet, but
  // tests do, and PR-3+ will migrate consumers incrementally).
  readonly factStore = new FactStore();
  private readonly registeredPasses: Pass<any, any>[] = [];
  private readonly passReaders = new Map<Pass<any, any>, Pass<any, any>[]>();
  /** FIFO queue of pending (pass, key) re-transfers. */
  private readonly passQueue: Array<{ pass: Pass<any, any>; key: unknown }> = [];
  /** Deduper for passQueue — keep at most one pending entry per (pass, key). */
  private readonly passQueueSet = new Set<string>();
  private passFactStoreOff: (() => void) | null = null;
  private draining = false;

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
  ) {
    this.analysisQueues = analyses.map(() => new Queue<QueuedBlock>());
    this.observers = analyses.filter(
      (m): m is ObservingAnalysis => m.observeWrite !== undefined,
    );

    // Per-field equality: each AnalysisPass registers latticeEquals under its name.
    const fieldEq = new Map<string, FieldEquals>();
    for (const a of analyses) {
      fieldEq.set(a.name, (x, y) => a.latticeEquals(x, y));
    }

    this.units = buildFunctionUnits(ast, functionEnvironments, analyses, fieldEq, this.factStore);
    for (const [key, unit] of this.units) {
      this.seedAnalysis(key, unit);
      this.enqueueTransform(key, unit.generation);
    }

    // Pass-graph dispatch: register the singleton structuralPass as a
    // baseline producer and subscribe the dispatch graph to factStore
    // onChange events. Every write that produces a lattice change wakes
    // readers via `handleFactChange`.
    this.register(structuralPass);
    // PR-4: register migrated source / analysis / transform passes so the
    // dispatch graph has visibility. `transfer` bodies are no-ops in this
    // PR — legacy dispatch still drives production analyses and
    // transforms, while the migrated passes back the `OptimizationHint`
    // fields via `HintStore` (so writes through `updateField` land in the
    // migrated passes' fact cells). PR-5 wires the interpreter to write
    // into `runtimeWritePass` / `runtimeCallPass`, at which point the
    // `transfer` bodies become live.
    this.register(runtimeWritePass);
    this.register(runtimeCallPass);
    this.register(typeAnalysisPass);
    this.register(constAnalysisPass);
    this.register(purityScopePass);
    this.register(callCountPass);
    this.register(deadBranchRule);
    this.register(constantFoldingRule);
    this.register(memoizationRule);
    this.passFactStoreOff = this.factStore.onChange(c => this.handleFactChange(c));

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
    this.drain();
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
    return this.drain(limit).size > 0;
  }

  // ── Pass-graph dispatch (register / enqueue / drain) ──────────────────

  /**
   * Register a pass with the dispatch graph. Idempotent: re-registering
   * the same pass is a no-op. Every pass must either declare
   * `affectedKeys` or set `coarse: true`; this is enforced here (plan
   * item: "Framework fails fast at register() if neither is declared").
   */
  register<K, V>(pass: Pass<K, V>): void {
    if (this.registeredPasses.indexOf(pass as Pass<any, any>) !== -1) return;
    if (pass.affectedKeys === undefined && pass.coarse !== true) {
      throw new Error(
        `[Worklist] pass "${pass.debugName}" must declare affectedKeys or coarse:true`,
      );
    }
    this.registeredPasses.push(pass as Pass<any, any>);
    // Index by each read so handleFactChange can fan out in O(1).
    for (const reader of pass.reads) {
      const list = this.passReaders.get(reader) ?? [];
      list.push(pass as Pass<any, any>);
      this.passReaders.set(reader, list);
    }
  }

  /**
   * Public runtime-observation API (PR-5). Writes `(pass, key) → value`
   * directly into the fact store, then drains any consumers the write
   * woke. Intended for `runtime`-tier source passes (`runtimeWritePass`,
   * `runtimeCallPass`) whose values come from the interpreter, not from
   * a `transfer`. Equality-gated like every other write — a same-value
   * write is a no-op and wakes nothing.
   *
   * Drain is invoked synchronously so transform side-effects (e.g.
   * memoization AST splice, JIT `patchFunction`) land before the next
   * interpreter instruction. Re-entry is guarded by `drainPasses`.
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
  }

  /**
   * Drain the pass-graph queue to fixpoint. Drain order: topological over
   * `reads` (depth from source passes) with tier tiebreaker
   * (runtime < analysis < transform < jit) and FIFO within tier.
   * Transforms defer while analysis items are pending for the same unit
   * (plan item (d)).
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
        const value = item.pass.transfer(this.passCtx, item.key);
        if (value !== undefined) {
          this.factStore.write(item.pass, item.key, value);
        }
      }
    } finally {
      this.draining = false;
    }
  }

  private passItemTag(pass: Pass<any, any>, key: unknown): string {
    // Symbol identity — unique per pass instance. Key is coerced to string
    // for dedup only; collisions across distinct keys with equal toString
    // (unlikely for NodeId/BlockId/Unit values used today) are absorbed by
    // the lattice.equals gate in `FactStore.write`.
    const passTag = (pass.id as symbol).toString();
    const keyTag =
      typeof key === "object" && key !== null
        ? String((key as { id?: unknown }).id ?? "")
        : String(key);
    return `${passTag}::${keyTag}`;
  }

  private readonly passCtx: PassCtx = {
    read: <K2, V2>(p: Pass<K2, V2>, key: K2) => this.factStore.read(p, key),
    readAll: <K2, V2>(p: Pass<K2, V2>) => this.factStore.readAll(p),
    unitFor: (scope: StmtNS.FileInput | StmtNS.FunctionDef) => this.units.get(scope),
  };

  private handleFactChange(change: FactChange<unknown, unknown>): void {
    const readers = this.passReaders.get(change.pass as Pass<any, any>);
    // Prune-hook: on a structuralPass write, walk every pass and give it
    // the chance to evict stale keys (plan item (c)).
    if ((change.pass as Pass<any, any>) === (structuralPass as Pass<any, any>)) {
      const unit = change.key as FunctionUnit;
      for (const p of this.registeredPasses) {
        if (p.prune === undefined) continue;
        const prev = this.factStore.readAll(p);
        const toEvict = p.prune(this.passCtx, unit, prev.keys());
        for (const k of toEvict) this.factStore.evict(p, k);
      }
    }
    if (readers === undefined || readers.length === 0) return;
    for (const reader of readers) {
      const keys = this.computeAffectedKeys(reader, change);
      for (const k of keys) this.enqueue(reader, k);
    }
  }

  private computeAffectedKeys(
    reader: Pass<any, any>,
    change: FactChange<unknown, unknown>,
  ): Iterable<unknown> {
    if (reader.affectedKeys !== undefined) {
      return reader.affectedKeys(change.pass, change.key);
    }
    // coarse: re-run on all previously-written keys.
    return Array.from(this.factStore.readAll(reader).keys());
  }

  /**
   * Drain selection: pick the queue index that should fire next.
   * Policy: lowest tier (runtime < analysis < transform < jit), then
   * FIFO. Transforms defer while any analysis item is queued for the
   * same unit (plan item (d) — unit-scoped predicate).
   */
  private pickNextPassItem(): number {
    const tierOrder: Record<string, number> = {
      runtime: 0,
      analysis: 1,
      transform: 2,
      jit: 3,
    };
    const defaultTier = 1; // "analysis" default per plan
    let bestIdx = -1;
    let bestTier = Infinity;
    for (let i = 0; i < this.passQueue.length; i++) {
      const { pass, key } = this.passQueue[i];
      const tier = pass.tier ? tierOrder[pass.tier] : defaultTier;
      // Defer transforms if any analysis item is pending for the same unit.
      if (pass.tier === "transform" || pass.tier === "jit") {
        const unit = this.unitOfKey(key);
        if (unit !== undefined && this.analysisPendingForUnit(unit, i)) continue;
      }
      if (tier < bestTier) {
        bestTier = tier;
        bestIdx = i;
      }
    }
    return bestIdx;
  }

  private unitOfKey(key: unknown): FunctionUnit | undefined {
    // Heuristic unit-extractor. FunctionUnit itself is passed by unit-keyed
    // passes (structuralPass, jitPass). Other key shapes (NodeId, BlockId,
    // Scope) land in PR-4+; this PR only needs unit-keyed resolution for
    // the deferral predicate.
    if (key && typeof key === "object" && "funcAst" in (key as object)) {
      return key as FunctionUnit;
    }
    if (key && typeof key === "object" && "kind" in (key as object)) {
      // AST Scope key
      return this.units.get(key as StmtNS.FileInput | StmtNS.FunctionDef);
    }
    return undefined;
  }

  private analysisPendingForUnit(unit: FunctionUnit, selfIdx: number): boolean {
    for (let i = 0; i < this.passQueue.length; i++) {
      if (i === selfIdx) continue;
      const { pass, key } = this.passQueue[i];
      if (pass.tier !== "analysis" && pass.tier !== undefined) continue;
      if (pass.tier === undefined) {
        // default tier is "analysis"
      }
      const u = this.unitOfKey(key);
      if (u === unit) return true;
    }
    return false;
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
    _scopeKey: StmtNS.FileInput | StmtNS.FunctionDef,
    calleeKey: StmtNS.FileInput | StmtNS.FunctionDef,
  ): void {
    const calleeUnit = this.units.get(calleeKey);
    if (!calleeUnit) return;
    calleeUnit.callCount++;
    this.markDirty(calleeKey, "data");
    // Only FunctionDef callees can be memoization callees — matches the
    // legacy gate. Engine paths that also call `observe(runtimeCallPass, …)`
    // from the interpreter remain a no-op idempotent second write under
    // the lattice equality gate.
    if (calleeKey instanceof StmtNS.FunctionDef) {
      this.observe(runtimeCallPass, calleeKey.id, calleeUnit.callCount);
    }
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

    // Capture the unit's structural version up-front. Several pass-graph
    // events below (the `structuralPass` write that primes purity, the
    // dead-branch / constant-folding seeds) all wake transforms whose
    // `reads` include `structuralPass` — so by the time we reach the
    // dedicated transform-drain section those transforms may have *already*
    // fired during purity's drain. A single capture here lets the
    // post-drain delta detect any fire regardless of which drain scheduled
    // it.
    const preTransformVersion = unit.structuralVersion;

    // PR-6a: purity is no longer a legacy ScopePass. Drive it through the
    // pass-graph — prime structuralPass so `purityScopePass.transfer` can
    // resolve the unit via `ctx.readAll(structuralPass)`, then enqueue &
    // drain. Idempotent under the lattice: same-version rewrites of
    // structuralPass suppress the fact-store listener, so this does not
    // spuriously wake other structuralPass readers on re-drain.
    this.factStore.write(structuralPass, unit, unit.structuralVersion);
    if (unit.funcAst instanceof StmtNS.FunctionDef) {
      this.enqueue(purityScopePass, unit.funcAst.id);
      this.drainPasses();
    }

    // PR-6c/6d: dead-branch elimination + constant folding are both
    // pass-graph-driven, sharing reads `[constAnalysisPass, structuralPass]`.
    // Each transfer sweeps `unit.body` (splicing const-bool `If`s and
    // rewriting Binary/Compare into Literal respectively) and bumps
    // `unit.structuralVersion` iff it mutated. Enqueue both seeds and
    // drain once; either may already have fired during the purity drain
    // above (woken by the `structuralPass` write priming purity), so the
    // version-delta capture lives at the top of `processTransform` —
    // see `preTransformVersion`.
    this.enqueue(deadBranchRule, unit);
    this.enqueue(constantFoldingRule, unit);
    // PR-6e: memoization is pass-graph-driven. Its transfer gates on
    // callCountPass >= threshold && purityScopePass === true; top-only
    // lattice means the first fire writes "fired" and subsequent
    // re-enqueues no-op via lattice equality. Legacy `appliedTransforms`
    // Set write preserved inside the wrap for test observability until
    // the final PR-6 demolition slice deletes the field.
    this.enqueue(memoizationRule, unit);
    this.drainPasses();
    const transformsFired = unit.structuralVersion !== preTransformVersion;

    if (transformsFired) {
      this._transformRounds++;
      unit.structuralVersion++;
      changed.add(item.scopeKey);
      this.markDirty(item.scopeKey, "structural");
    }
    // Legacy node-level transforms produced an `extraInvalidate` set for
    // child-unit invalidation; they're all migrated to Pass<K,V> now and
    // any cross-unit mutation (e.g. memoization wrapping a child) bumps
    // the child's structuralVersion directly inside the transfer.
    const extraInvalidate = new Set<StmtNS.FileInput | StmtNS.FunctionDef>();
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

    // Pass-graph write-through: bump the unit's AstVersion fact. Lockstep
    // with `unit.structuralVersion++` (which lives in `processTransform`)
    // — this is the single place both sources are advanced together in
    // PR-2a. PR-2b removes the legacy field and this pair collapses to
    // one write.
    this.factStore.write(structuralPass, unit, unit.structuralVersion);
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

}
