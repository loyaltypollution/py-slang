import { ExprNS, StmtNS } from "../../ast-types";
import type { AssumptionChain } from "../assumption/chain";
import { forkBody, visibleBody } from "../speculation/assumption-bodies";
import type { Function } from "../program/function";
import type { FunctionView } from "../program/program-view";
import { isLocal, type SlotLookup } from "../program/slot-table";
import { functionOfBlock, wakeOwningFunction } from "../program/program-view";
import type { TransformRule } from "../framework/analysis";
import { livenessAnalysis, perStatementLiveOut } from "../analysis";
import { walkExpr, walkExprs } from "./witness-utils";

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

/** Liveness under-approximates inside lambdas, so treat locals read by any
 *  nested Lambda/MultiLambda body as escaping. */
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
      // Unresolved name: not a local escape.
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

function buildLiveOutMap(unit: Function, chain: AssumptionChain): Map<number, ReadonlySet<number>> {
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

function forEachNestedBody(
  stmt: StmtNS.Stmt,
  visit: (body: readonly StmtNS.Stmt[]) => void,
): void {
  if (stmt instanceof StmtNS.If) {
    visit(stmt.body);
    if (stmt.elseBlock) visit(stmt.elseBlock);
  } else if (stmt instanceof StmtNS.While || stmt instanceof StmtNS.For) {
    visit(stmt.body);
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
    forEachNestedBody(s, (body) =>
      collectRemovableStmtIds(body, liveOutMap, slotLookup, escaped, out),
    );
  }
}

function findAssignById(stmts: readonly StmtNS.Stmt[], stmtId: number): StmtNS.Assign | undefined {
  for (const stmt of stmts) {
    if (stmt instanceof StmtNS.Assign && stmt.id === stmtId) return stmt;
    let found: StmtNS.Assign | undefined;
    forEachNestedBody(stmt, (body) => {
      if (found === undefined) found = findAssignById(body, stmtId);
    });
    if (found !== undefined) return found;
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
    forEachNestedBody(stmt, (body) => {
      if (sweepRemovalsById(body as StmtNS.Stmt[], removableIds)) changed = true;
    });
    i++;
  }
  return changed;
}

function memo<K, V>(cache: Map<K, V>, key: K, compute: (key: K) => V): V {
  let value = cache.get(key);
  if (value === undefined) {
    value = compute(key);
    cache.set(key, value);
  }
  return value;
}

function witnessForRemoval(
  unit: Function,
  lineage: readonly AssumptionChain[],
  stmtId: number,
  liveOutCache: Map<AssumptionChain, ReadonlyMap<number, ReadonlySet<number>>>,
  escapedCache: Map<AssumptionChain, ReadonlySet<number>>,
): AssumptionChain | undefined {
  for (const witness of lineage) {
    const body = visibleBody(unit, witness);
    const stmt = findAssignById(body, stmtId);
    if (stmt === undefined) continue;

    const liveOutMap = memo(liveOutCache, witness, (w) => buildLiveOutMap(unit, w));
    const escaped = memo(escapedCache, witness, () => escapedLocalSlotsIn(body, unit.slotLookup));

    if (removableAssignment(stmt, liveOutMap, unit.slotLookup, escaped)) return witness;
  }
  return undefined;
}

export const deadStoreRule: TransformRule = {
  bind(wl) {
    wl.onTransformFactDirty(deadStoreRule, livenessAnalysis.env, wakeOwningFunction(functionOfBlock));
  },
  sweep(unit: Function, chain: AssumptionChain, _view: FunctionView): boolean {
    // Top-level names are observable; only function-scope slots are safe to DSE.
    if (unit.funcAst instanceof StmtNS.FileInput) return false;

    const body = visibleBody(unit, chain);
    const liveOutCache = new Map<AssumptionChain, ReadonlyMap<number, ReadonlySet<number>>>();
    const escapedCache = new Map<AssumptionChain, ReadonlySet<number>>();
    const liveOutMap = memo(liveOutCache, chain, (w) => buildLiveOutMap(unit, w));
    const escaped = memo(escapedCache, chain, () => escapedLocalSlotsIn(body, unit.slotLookup));

    const removableNow = new Set<number>();
    collectRemovableStmtIds(body, liveOutMap, unit.slotLookup, escaped, removableNow);
    if (removableNow.size === 0) return false;

    const lineage: AssumptionChain[] = [];
    for (let cur: AssumptionChain | undefined = chain; cur !== undefined; cur = cur.parent) {
      lineage.push(cur);
    }
    lineage.reverse();
    const removalsByWitness = new Map<AssumptionChain, Set<number>>();
    for (const stmtId of removableNow) {
      const witness = witnessForRemoval(unit, lineage, stmtId, liveOutCache, escapedCache);
      if (witness === undefined) continue;
      let bucket = removalsByWitness.get(witness);
      if (bucket === undefined) {
        bucket = new Set<number>();
        removalsByWitness.set(witness, bucket);
      }
      bucket.add(stmtId);
    }

    let changed = false;
    for (const witness of lineage) {
      const removableIds = removalsByWitness.get(witness);
      if (removableIds === undefined || removableIds.size === 0) continue;
      const witnessBody = forkBody(unit, witness);
      if (sweepRemovalsById(witnessBody, removableIds)) changed = true;
    }
    return changed;
  },
};
