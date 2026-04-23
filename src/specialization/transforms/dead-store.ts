// Dead-store elimination. Splices out `x = <pure expr>` when x is not live
// at that program point. Designed to fire *after* dead-branch and
// constant-folding have removed the only consumers of a slot.
//
// Witness-aware: each removal is authorized at the shallowest chain where
// the assignment is still present, pure, and dead by the liveness facts.

import { ExprNS, StmtNS } from "../../ast-types";
import type { Speculation } from "../framework/assumption-chain";
import { forkBody, visibleBody } from "../framework/assumption-bodies";
import type { Unit } from "../framework/function-unit";
import type { ProgramTopology } from "../framework/topology";
import { isLocal, type SlotLookup } from "../framework/slot-table";
import { unitOfBlock, wakeOwningUnit } from "../framework/analysis";
import type { TransformRule } from "../framework/analysis";
import { livenessAnalysis, perStatementLiveOut } from "../liveness-analysis/analysis";
import { lineageTo, walkExpr, walkExprs } from "./witness-utils";

// Conservative syntactic purity. Call/Subscript/List/Starred/Lambda are
// excluded: they may side-effect, throw, or capture.
function isPureRhs(expr: ExprNS.Expr, slotLookup: SlotLookup): boolean {
  if (
    expr instanceof ExprNS.Literal ||
    expr instanceof ExprNS.BigIntLiteral ||
    expr instanceof ExprNS.None ||
    expr instanceof ExprNS.Complex
  ) {
    return true;
  }
  if (expr instanceof ExprNS.Variable) return isLocal(slotLookup(expr.name));
  if (expr instanceof ExprNS.Grouping) return isPureRhs(expr.expression, slotLookup);
  if (expr instanceof ExprNS.Unary) return isPureRhs(expr.right, slotLookup);
  if (
    expr instanceof ExprNS.Binary ||
    expr instanceof ExprNS.Compare ||
    expr instanceof ExprNS.BoolOp
  ) {
    return isPureRhs(expr.left, slotLookup) && isPureRhs(expr.right, slotLookup);
  }
  if (expr instanceof ExprNS.Ternary) {
    return (
      isPureRhs(expr.predicate, slotLookup) &&
      isPureRhs(expr.consequent, slotLookup) &&
      isPureRhs(expr.alternative, slotLookup)
    );
  }
  return false;
}

/** Local slots read inside any Lambda/MultiLambda body in `stmts`. Liveness
 *  under-approximates inside lambdas, so treat such locals as escaping. */
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
  const visitInLambda = (expr: ExprNS.Expr) => {
    recordVar(expr);
    if (expr instanceof ExprNS.Lambda) walkExpr(expr.body, visitInLambda);
    else if (expr instanceof ExprNS.MultiLambda) walkExprs(expr.body, visitInLambda);
  };
  walkExprs(stmts, (expr) => {
    if (expr instanceof ExprNS.Lambda) walkExpr(expr.body, visitInLambda);
    else if (expr instanceof ExprNS.MultiLambda) walkExprs(expr.body, visitInLambda);
  });
  return escaped;
}

// Keyed by `stmt.id`, stable across deep-cloned forked bodies.
function buildLiveOutMap(unit: Unit, chain: Speculation): Map<number, ReadonlySet<number>> {
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

function forEachNestedBody(
  stmts: readonly StmtNS.Stmt[],
  visit: (body: readonly StmtNS.Stmt[]) => void,
): void {
  for (const s of stmts) {
    if (s instanceof StmtNS.If) {
      visit(s.body);
      if (s.elseBlock) visit(s.elseBlock);
    } else if (isLoopStmt(s)) {
      visit(s.body);
    }
  }
}

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
  }
  forEachNestedBody(stmts, (body) =>
    collectRemovableStmtIds(body, liveOutMap, slotLookup, escaped, out),
  );
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
    wl.onTransformFactDirty(deadStoreRule, livenessAnalysis.env, wakeOwningUnit(unitOfBlock));
  },
  sweep(unit: Unit, chain: Speculation, _topology: ProgramTopology): boolean {
    // Skip module scope: top-level names are observable (imports, REPL, harness).
    // Function-scope locals are dead at return; DSE on them is always sound.
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
