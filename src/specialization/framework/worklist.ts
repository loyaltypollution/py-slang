// src/specialization/framework/worklist.ts — CFG-based worklist DFA driver

import { ExprNS, StmtNS } from "../../ast-types";
import type { BasicBlock, BlockId, CFG } from "./cfg";
import { buildCFG } from "./cfg";
import type { HintStore } from "./hint";
import type { AnalysisModule, TransformRule } from "./interfaces";
import { MutableEnv } from "./dfa-driver";
import type { SlotLookup } from "./slot-table";
import { applyTransformPass } from "./transform";

// ── Session ──────────────────────────────────────────────────────────────────

/**
 * Per-analysis worklist state.
 *
 * `out` maps block → post-transfer environment.
 *   - `null` means "never processed" (distinct from an empty env).
 *   - Seed-only initialization means unreachable blocks stay `null` forever.
 */
export interface AnalysisSession<L> {
  readonly module: AnalysisModule<L>;
  readonly out: Map<BlockId, MutableEnv<L> | null>;
}

export function makeSession<L>(module: AnalysisModule<L>, cfg: CFG): AnalysisSession<L> {
  const out = new Map<BlockId, MutableEnv<L> | null>();
  for (const block of cfg.blocks) {
    out.set(block.id, null);
  }
  return { module, out };
}

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
  session: AnalysisSession<L>,
): MutableEnv<L> {
  const direction = session.module.direction;
  let result: MutableEnv<L> | null = null;
  for (const inc of incomingBlocks(block, direction)) {
    const incOut = session.out.get(inc.id) ?? null;
    if (incOut === null) continue; // never processed — skip
    if (result === null) {
      result = incOut.snapshot();
    } else {
      mergeInto(result, incOut, session.module);
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
  session: AnalysisSession<L>,
  hints: HintStore,
  slotLookup: SlotLookup,
): MutableEnv<L> {
  const env = inEnv.snapshot(); // OUT starts as a copy of IN
  const visitor = session.module.makeExprVisitor(hints, env, slotLookup);
  const stmts = block.stmts;
  if (session.module.direction === "backward") {
    for (let i = stmts.length - 1; i >= 0; i--) {
      transferStmt(stmts[i], env, visitor, session.module, slotLookup);
    }
  } else {
    for (const stmt of stmts) {
      transferStmt(stmt, env, visitor, session.module, slotLookup);
    }
  }
  return env;
}

// ── Worklist ─────────────────────────────────────────────────────────────────

/**
 * Run one analysis to fixpoint on the given CFG.
 *
 * Seed-only initialization: only the seed block (entry for forward, exit for
 * backward) is initially enqueued. Blocks are reached as their incoming
 * neighbors propagate changed OUTs.
 *
 * Uses an index pointer (O(1) dequeue) instead of Array.shift() (O(n)).
 */
function drainWorklist<L>(
  cfg: CFG,
  session: AnalysisSession<L>,
  hints: HintStore,
  slotLookup: SlotLookup,
): void {
  const direction = session.module.direction;
  const sentinel = sentinelBlock(cfg, direction);
  const inQueue = new Set<BlockId>();
  const queue: BasicBlock[] = [];

  function enqueue(block: BasicBlock): void {
    if (block === sentinel) return; // sentinel is never transferred
    if (!inQueue.has(block.id)) {
      inQueue.add(block.id);
      queue.push(block);
    }
  }

  // Seed with the appropriate entry point.
  enqueue(seedBlock(cfg, direction));

  let head = 0;
  while (head < queue.length) {
    const block = queue[head++];
    inQueue.delete(block.id);

    const inEnv = computeBlockIN(block, session);
    const outEnv = transferBlock(block, inEnv, session, hints, slotLookup);

    const prevOut = session.out.get(block.id) ?? null;
    if (prevOut === null || !outEnv.equals(prevOut, session.module.leq.bind(session.module))) {
      session.out.set(block.id, outEnv);
      for (const next of outgoingBlocks(block, direction)) {
        enqueue(next);
      }
    }
  }
}

/**
 * Run all analyses to convergence on a single CFG.
 *
 * Analyses run sequentially. Type analysis must run before const analysis
 * (const analysis reads type hints); hint fields are disjoint so ordering
 * within a round is safe.
 */
export function drainAllAnalyses(
  cfg: CFG,
  sessions: AnalysisSession<any>[],
  hints: HintStore,
  slotLookup: SlotLookup,
): void {
  for (const session of sessions) {
    drainWorklist(cfg, session, hints, slotLookup);
  }
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Run the CFG-based optimization pipeline:
 *   build CFG → analyze (worklist) → transform → rebuild CFG → repeat
 *
 * Repeats until no transform fires or `maxRounds` is reached.
 * After the final round, one last analysis pass annotates all surviving nodes.
 *
 * @deprecated Use OptimizationSession.converge() instead. Retained for differential testing.
 */
export function runCFGOptimization(
  stmts: StmtNS.Stmt[],
  analyses: AnalysisModule<any>[],
  transforms: TransformRule[],
  hints: HintStore,
  slotLookup: SlotLookup,
  maxRounds = 10,
): void {
  for (let round = 0; round < maxRounds; round++) {
    const cfg = buildCFG(stmts);
    const sessions = analyses.map(m => makeSession(m, cfg));
    drainAllAnalyses(cfg, sessions, hints, slotLookup);

    let changed = false;
    for (const rule of transforms) {
      changed = applyTransformPass(stmts, rule, hints) || changed;
    }
    if (!changed) return;
    // CFG is invalidated by stmt transforms — rebuild next round.
  }

  // Iteration cap: run one final analysis to annotate surviving expressions.
  const cfg = buildCFG(stmts);
  const sessions = analyses.map(m => makeSession(m, cfg));
  drainAllAnalyses(cfg, sessions, hints, slotLookup);
}
