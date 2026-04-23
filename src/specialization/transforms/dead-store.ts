// Dead-store elimination. Splices out `x = <pure expr>` when x is not live
// at that program point (i.e. no downstream read before a re-definition).
//
// Idempotent: once an assignment is spliced out, it no longer matches the
// pattern. Designed to fire *after* dead-branch and constant-folding have
// removed the only consumers of a slot; this is the pass that collapses the
// runtime-const "gate" pattern described in the poster.
//
// Witness-aware: every actual removal is authorized at the shallowest chain
// where the assignment is still present, syntactically pure, and dead by the
// liveness facts. One sweep can therefore publish removals shallow→deep along
// the active future-dispatch lineage.

import { ExprNS, StmtNS } from "../../ast-types";
import type { Speculation } from "../framework/assumption-chain";
import { forkBody, visibleBody } from "../framework/assumption-bodies";
import type { Unit } from "../framework/function-unit";
import type { ProgramTopology } from "../framework/topology";
import { isLocal, type SlotLookup } from "../framework/slot-table";
import { unitOfBlock, wakeOwningUnit } from "../framework/analysis";
import type { TransformRule } from "../framework/analysis";
import { livenessAnalysis, perStatementLiveOut } from "../liveness-analysis/analysis";
import { lineageTo } from "./witness-utils";

/** Conservative syntactic purity: an expression whose evaluation cannot
 *  observe or produce side effects and whose elision is safe even if its
 *  slot target is dead. Calls, subscripts, lambdas (capture semantics are
 *  not tracked by liveness here), and list literals are excluded. */
function isPureRhs(expr: ExprNS.Expr, slotLookup: SlotLookup): boolean {
  if (expr instanceof ExprNS.Literal) return true;
  if (expr instanceof ExprNS.BigIntLiteral) return true;
  if (expr instanceof ExprNS.None) return true;
  if (expr instanceof ExprNS.Complex) return true;
  if (expr instanceof ExprNS.Variable) {
    const info = slotLookup(expr.name);
    return isLocal(info);
  }
  if (expr instanceof ExprNS.Grouping) return isPureRhs(expr.expression, slotLookup);
  if (expr instanceof ExprNS.Unary) return isPureRhs(expr.right, slotLookup);
  if (expr instanceof ExprNS.Binary) {
    return isPureRhs(expr.left, slotLookup) && isPureRhs(expr.right, slotLookup);
  }
  if (expr instanceof ExprNS.Compare) {
    return isPureRhs(expr.left, slotLookup) && isPureRhs(expr.right, slotLookup);
  }
  if (expr instanceof ExprNS.BoolOp) {
    return isPureRhs(expr.left, slotLookup) && isPureRhs(expr.right, slotLookup);
  }
  if (expr instanceof ExprNS.Ternary) {
    return (
      isPureRhs(expr.predicate, slotLookup) &&
      isPureRhs(expr.consequent, slotLookup) &&
      isPureRhs(expr.alternative, slotLookup)
    );
  }
  // Call, Subscript, List, Starred, Lambda, MultiLambda: impure.
  return false;
}

/** Typed walk of every sub-expression, invoking `onExpr` on each. Descends
 *  into lambda bodies — callers use this to find variable reads that would
 *  escape the current scope's liveness view. */
function walkAllExprs(expr: ExprNS.Expr, onExpr: (e: ExprNS.Expr) => void): void {
  onExpr(expr);
  if (
    expr instanceof ExprNS.Binary ||
    expr instanceof ExprNS.Compare ||
    expr instanceof ExprNS.BoolOp
  ) {
    walkAllExprs(expr.left, onExpr);
    walkAllExprs(expr.right, onExpr);
    return;
  }
  if (expr instanceof ExprNS.Unary) {
    walkAllExprs(expr.right, onExpr);
    return;
  }
  if (expr instanceof ExprNS.Grouping) {
    walkAllExprs(expr.expression, onExpr);
    return;
  }
  if (expr instanceof ExprNS.Ternary) {
    walkAllExprs(expr.predicate, onExpr);
    walkAllExprs(expr.consequent, onExpr);
    walkAllExprs(expr.alternative, onExpr);
    return;
  }
  if (expr instanceof ExprNS.Call) {
    walkAllExprs(expr.callee, onExpr);
    for (const a of expr.args) walkAllExprs(a, onExpr);
    return;
  }
  if (expr instanceof ExprNS.List) {
    for (const el of expr.elements) walkAllExprs(el, onExpr);
    return;
  }
  if (expr instanceof ExprNS.Subscript) {
    walkAllExprs(expr.value, onExpr);
    walkAllExprs(expr.index, onExpr);
    return;
  }
  if (expr instanceof ExprNS.Starred) {
    walkAllExprs(expr.value, onExpr);
    return;
  }
  if (expr instanceof ExprNS.Lambda) {
    walkAllExprs(expr.body, onExpr);
    return;
  }
  if (expr instanceof ExprNS.MultiLambda) {
    for (const s of expr.body) walkStmtAllExprs(s, onExpr);
    return;
  }
}

function walkStmtAllExprs(stmt: StmtNS.Stmt, onExpr: (e: ExprNS.Expr) => void): void {
  if (stmt instanceof StmtNS.Assign) {
    walkAllExprs(stmt.target, onExpr);
    walkAllExprs(stmt.value, onExpr);
    return;
  }
  if (stmt instanceof StmtNS.AnnAssign) {
    walkAllExprs(stmt.value, onExpr);
    return;
  }
  if (stmt instanceof StmtNS.Return) {
    if (stmt.value) walkAllExprs(stmt.value, onExpr);
    return;
  }
  if (stmt instanceof StmtNS.If) {
    walkAllExprs(stmt.condition, onExpr);
    for (const s of stmt.body) walkStmtAllExprs(s, onExpr);
    if (stmt.elseBlock) for (const s of stmt.elseBlock) walkStmtAllExprs(s, onExpr);
    return;
  }
  if (stmt instanceof StmtNS.While) {
    walkAllExprs(stmt.condition, onExpr);
    for (const s of stmt.body) walkStmtAllExprs(s, onExpr);
    return;
  }
  if (stmt instanceof StmtNS.For) {
    walkAllExprs(stmt.iter, onExpr);
    for (const s of stmt.body) walkStmtAllExprs(s, onExpr);
    return;
  }
  if (stmt instanceof StmtNS.SimpleExpr) {
    walkAllExprs(stmt.expression, onExpr);
    return;
  }
  if (stmt instanceof StmtNS.Assert) {
    walkAllExprs(stmt.value, onExpr);
    return;
  }
  if (stmt instanceof StmtNS.FileInput) {
    for (const s of stmt.statements) walkStmtAllExprs(s, onExpr);
  }
}

/** Scan the currently visible body for every Lambda/MultiLambda expression and
 *  collect the set of this unit's local slots that appear as free variable
 *  reads inside any lambda body. Lambda bodies resolve names against a
 *  different scope's env; this unit's `slotLookup` returns local info only
 *  for names that *this unit* owns, which is the conservative "escape" set. */
function escapedLocalSlotsIn(
  stmts: ReadonlyArray<StmtNS.Stmt>,
  slotLookup: SlotLookup,
): Set<number> {
  const escaped = new Set<number>();
  const recordVar = (inner: ExprNS.Expr) => {
    if (!(inner instanceof ExprNS.Variable)) return;
    try {
      const info = slotLookup(inner.name);
      if (isLocal(info)) escaped.add(info.slot);
    } catch {
      // Name unresolvable in this unit's scope — not a local escape.
    }
  };
  const visit = (expr: ExprNS.Expr) => {
    if (expr instanceof ExprNS.Lambda) {
      walkAllExprs(expr.body, recordVar);
    } else if (expr instanceof ExprNS.MultiLambda) {
      for (const s of expr.body) walkStmtAllExprs(s, recordVar);
    }
  };
  for (const stmt of stmts) walkStmtAllExprs(stmt, visit);
  return escaped;
}

/** Build `Map<stmt.id, ReadonlySet<number>>` of per-statement live-OUT for
 *  every statement in every block of `unit`. `stmt.id` is stable across
 *  deep-cloned forked bodies, so witness discovery can compare the same
 *  logical statement across ancestor bodies. */
function buildLiveOutMap(
  unit: Unit,
  chain: Speculation,
): Map<number, ReadonlySet<number>> {
  const out = new Map<number, ReadonlySet<number>>();
  for (const block of unit.blockMap.values()) {
    const liveOuts = perStatementLiveOut(block, unit.slotLookup, chain);
    const stmts = block.stmts;
    for (let i = 0; i < stmts.length; i++) {
      out.set(stmts[i].id, liveOuts[i]);
    }
  }
  return out;
}

function removableAssignment(
  stmt: StmtNS.Assign,
  liveOutMap: ReadonlyMap<number, ReadonlySet<number>>,
  slotLookup: SlotLookup,
  escaped: ReadonlySet<number>,
): boolean {
  if (!(stmt.target instanceof ExprNS.Variable)) return false;
  const info = slotLookup(stmt.target.name);
  const liveOut = liveOutMap.get(stmt.id);
  return (
    isLocal(info) &&
    liveOut !== undefined &&
    !liveOut.has(info.slot) &&
    !escaped.has(info.slot) &&
    isPureRhs(stmt.value, slotLookup)
  );
}

const isLoopStmt = (s: StmtNS.Stmt): s is StmtNS.While | StmtNS.For =>
  s instanceof StmtNS.While || s instanceof StmtNS.For;

function collectRemovableStmtIds(
  stmts: readonly StmtNS.Stmt[],
  liveOutMap: ReadonlyMap<number, ReadonlySet<number>>,
  slotLookup: SlotLookup,
  escaped: ReadonlySet<number>,
  out: Set<number>,
): void {
  for (const s of stmts) {
    if (s instanceof StmtNS.Assign && removableAssignment(s, liveOutMap, slotLookup, escaped)) {
      out.add(s.id);
    }
    if (s instanceof StmtNS.If) {
      collectRemovableStmtIds(s.body, liveOutMap, slotLookup, escaped, out);
      if (s.elseBlock) collectRemovableStmtIds(s.elseBlock, liveOutMap, slotLookup, escaped, out);
    } else if (isLoopStmt(s)) {
      collectRemovableStmtIds(s.body, liveOutMap, slotLookup, escaped, out);
    }
  }
}

function findAssignById(stmts: readonly StmtNS.Stmt[], stmtId: number): StmtNS.Assign | undefined {
  for (const stmt of stmts) {
    if (stmt instanceof StmtNS.Assign && stmt.id === stmtId) return stmt;
    if (stmt instanceof StmtNS.If) {
      const inBody = findAssignById(stmt.body, stmtId);
      if (inBody !== undefined) return inBody;
      if (stmt.elseBlock) {
        const inElse = findAssignById(stmt.elseBlock, stmtId);
        if (inElse !== undefined) return inElse;
      }
    } else if (isLoopStmt(stmt)) {
      const nested = findAssignById(stmt.body, stmtId);
      if (nested !== undefined) return nested;
    }
  }
  return undefined;
}

function sweepRemovalsById(stmts: StmtNS.Stmt[], removableIds: ReadonlySet<number>): boolean {
  let changed = false;
  let i = 0;
  while (i < stmts.length) {
    const stmt = stmts[i];
    if (stmt instanceof StmtNS.Assign && removableIds.has(stmt.id)) {
      stmts.splice(i, 1);
      changed = true;
      continue;
    }
    if (stmt instanceof StmtNS.If) {
      if (sweepRemovalsById(stmt.body, removableIds)) changed = true;
      if (stmt.elseBlock && sweepRemovalsById(stmt.elseBlock, removableIds)) changed = true;
    } else if (isLoopStmt(stmt)) {
      if (sweepRemovalsById(stmt.body, removableIds)) changed = true;
    }
    i++;
  }
  return changed;
}

function witnessForRemoval(
  unit: Unit,
  lineage: readonly Speculation[],
  stmtId: number,
  liveOutCache: Map<Speculation, ReadonlyMap<number, ReadonlySet<number>>>,
  escapedCache: Map<Speculation, ReadonlySet<number>>,
): Speculation | undefined {
  for (const witness of lineage) {
    const body = visibleBody(unit, witness);
    const stmt = findAssignById(body, stmtId);
    if (stmt === undefined) continue;

    let liveOutMap = liveOutCache.get(witness);
    if (liveOutMap === undefined) {
      liveOutMap = buildLiveOutMap(unit, witness);
      liveOutCache.set(witness, liveOutMap);
    }

    let escaped = escapedCache.get(witness);
    if (escaped === undefined) {
      escaped = escapedLocalSlotsIn(body, unit.slotLookup);
      escapedCache.set(witness, escaped);
    }

    if (removableAssignment(stmt, liveOutMap, unit.slotLookup, escaped)) return witness;
  }
  return undefined;
}

export const deadStoreRule: TransformRule = {
  bind(wl) {
    wl.onTransformFactDirty(
      deadStoreRule,
      livenessAnalysis.env,
      wakeOwningUnit(unitOfBlock),
    );
  },
  sweep(unit: Unit, chain: Speculation, _topology: ProgramTopology): boolean {
    // Skip the module (FileInput) scope. Module-top-level names are part of
    // the program's observable namespace — other modules can import them,
    // REPL/tool consumers can inspect them after execution, and the
    // conductor's benchmark harness reads module-global bindings. Eliding
    // a top-level `x = 1` whose slot has no syntactic reader inside the
    // module would change observable state. Function-scope locals, by
    // contrast, are dead at return; DSE on them is always sound.
    if (unit.funcAst instanceof StmtNS.FileInput) return false;

    const body = visibleBody(unit, chain);
    const liveOutCache = new Map<Speculation, ReadonlyMap<number, ReadonlySet<number>>>();
    const escapedCache = new Map<Speculation, ReadonlySet<number>>();
    const liveOutMap = buildLiveOutMap(unit, chain);
    liveOutCache.set(chain, liveOutMap);
    const escaped = escapedLocalSlotsIn(body, unit.slotLookup);
    escapedCache.set(chain, escaped);

    const removableNow = new Set<number>();
    collectRemovableStmtIds(body, liveOutMap, unit.slotLookup, escaped, removableNow);
    if (removableNow.size === 0) return false;

    const lineage = lineageTo(chain);
    const removalsByWitness = new Map<Speculation, Set<number>>();
    for (const stmtId of removableNow) {
      const witness = witnessForRemoval(unit, lineage, stmtId, liveOutCache, escapedCache);
      if (witness === undefined) continue;
      const bucket = removalsByWitness.get(witness) ?? new Set<number>();
      bucket.add(stmtId);
      removalsByWitness.set(witness, bucket);
    }

    let changed = false;
    for (const witness of lineage) {
      const removableIds = removalsByWitness.get(witness);
      if (removableIds === undefined || removableIds.size === 0) continue;
      const witnessBody = forkBody(unit, witness);
      changed = sweepRemovalsById(witnessBody, removableIds) || changed;
    }
    return changed;
  },
};
