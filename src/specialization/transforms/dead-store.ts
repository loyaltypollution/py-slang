import { ExprNS, StmtNS } from "../../ast-types";
import { isRoot, type AssumptionChain } from "../assumption/chain";
import {
  forkBody,
  invalidateDescendantVariants,
  visibleBody,
} from "../speculation/assumption-bodies";
import type { Function } from "../program/function/function";
import type { FunctionLocator } from "../program/function/manager";
import { isLocal, type SlotLookup } from "../program/function/slot-table";
import type { TransformRule } from "../framework/analysis";
import { livenessAnalysis, perStatementLiveOut } from "../analysis";
import { BaseStmtVisitor, walkExpr, walkExprs } from "./expr-visitor";
import { transformResultFor } from "./witness-sweep";

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
  walkExprs(stmts, expr => {
    if (expr instanceof ExprNS.Lambda) walkExpr(expr.body, visitInLambda);
    else if (expr instanceof ExprNS.MultiLambda) walkExprs(expr.body, visitInLambda);
  });
  return escaped;
}

function buildLiveOutMap(unit: Function, chain: AssumptionChain): Map<number, ReadonlySet<number>> {
  const out = new Map<number, ReadonlySet<number>>();
  for (const block of unit.cfg.blocks) {
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

class RemovableCollector extends BaseStmtVisitor {
  constructor(
    private readonly liveOutMap: ReadonlyMap<number, ReadonlySet<number>>,
    private readonly slotLookup: SlotLookup,
    private readonly escaped: ReadonlySet<number>,
    readonly into: Set<number>,
  ) {
    super();
  }

  walk(stmts: readonly StmtNS.Stmt[]): void {
    for (const s of stmts) {
      if (
        s instanceof StmtNS.Assign &&
        removableAssignment(s, this.liveOutMap, this.slotLookup, this.escaped)
      ) {
        this.into.add(s.id);
      }
      s.accept(this);
    }
  }

  visitIfStmt(stmt: StmtNS.If): void {
    this.walk(stmt.body);
    if (stmt.elseBlock) this.walk(stmt.elseBlock);
  }
  visitWhileStmt(stmt: StmtNS.While): void {
    this.walk(stmt.body);
  }
  visitForStmt(stmt: StmtNS.For): void {
    this.walk(stmt.body);
  }
  visitFileInputStmt(stmt: StmtNS.FileInput): void {
    this.walk(stmt.statements);
  }
}

class AssignFinder extends BaseStmtVisitor {
  result?: StmtNS.Assign;
  constructor(private readonly stmtId: number) {
    super();
  }

  walk(stmts: readonly StmtNS.Stmt[]): void {
    for (const s of stmts) {
      if (this.result !== undefined) return;
      if (s instanceof StmtNS.Assign && s.id === this.stmtId) {
        this.result = s;
        return;
      }
      s.accept(this);
    }
  }

  visitIfStmt(stmt: StmtNS.If): void {
    this.walk(stmt.body);
    if (this.result === undefined && stmt.elseBlock) this.walk(stmt.elseBlock);
  }
  visitWhileStmt(stmt: StmtNS.While): void {
    this.walk(stmt.body);
  }
  visitForStmt(stmt: StmtNS.For): void {
    this.walk(stmt.body);
  }
  visitFileInputStmt(stmt: StmtNS.FileInput): void {
    this.walk(stmt.statements);
  }
}

class RemovalSplicer extends BaseStmtVisitor {
  changed = false;
  constructor(private readonly removableIds: ReadonlySet<number>) {
    super();
  }

  sweep(stmts: StmtNS.Stmt[]): void {
    let i = 0;
    while (i < stmts.length) {
      const s = stmts[i];
      if (s instanceof StmtNS.Assign && this.removableIds.has(s.id)) {
        stmts.splice(i, 1);
        this.changed = true;
        continue;
      }
      s.accept(this);
      i++;
    }
  }

  visitIfStmt(stmt: StmtNS.If): void {
    this.sweep(stmt.body);
    if (stmt.elseBlock) this.sweep(stmt.elseBlock);
  }
  visitWhileStmt(stmt: StmtNS.While): void {
    this.sweep(stmt.body);
  }
  visitForStmt(stmt: StmtNS.For): void {
    this.sweep(stmt.body);
  }
  visitFileInputStmt(stmt: StmtNS.FileInput): void {
    this.sweep(stmt.statements);
  }
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
    const finder = new AssignFinder(stmtId);
    finder.walk(body);
    if (finder.result === undefined) continue;

    const liveOutMap = memo(liveOutCache, witness, w => buildLiveOutMap(unit, w));
    const escaped = memo(escapedCache, witness, () => escapedLocalSlotsIn(body, unit.slotLookup));

    if (removableAssignment(finder.result, liveOutMap, unit.slotLookup, escaped)) return witness;
  }
  return undefined;
}

export const deadStoreRule: TransformRule = {
  bind(wl) {
    wl.onTransformFactDirty(deadStoreRule, livenessAnalysis.env, (_, b) => [b.unit]);
  },
  sweep(unit: Function, chain: AssumptionChain, _view: FunctionLocator) {
    // Top-level names are observable; only function-scope slots are safe to DSE.
    if (unit.funcAst instanceof StmtNS.FileInput) return transformResultFor([]);

    const body = visibleBody(unit, chain);
    const liveOutCache = new Map<AssumptionChain, ReadonlyMap<number, ReadonlySet<number>>>();
    const escapedCache = new Map<AssumptionChain, ReadonlySet<number>>();
    const liveOutMap = memo(liveOutCache, chain, w => buildLiveOutMap(unit, w));
    const escaped = memo(escapedCache, chain, () => escapedLocalSlotsIn(body, unit.slotLookup));

    const removableNow = new Set<number>();
    new RemovableCollector(liveOutMap, unit.slotLookup, escaped, removableNow).walk(body);
    if (removableNow.size === 0) return transformResultFor([]);

    const lineage: AssumptionChain[] = [];
    for (let cur: AssumptionChain = chain; ; ) {
      lineage.push(cur);
      if (isRoot(cur)) break;
      cur = cur.parent;
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

    const touchedWitnesses: AssumptionChain[] = [];
    for (const witness of lineage) {
      const removableIds = removalsByWitness.get(witness);
      if (removableIds === undefined || removableIds.size === 0) continue;
      const witnessBody = forkBody(unit, witness);
      const splicer = new RemovalSplicer(removableIds);
      splicer.sweep(witnessBody);
      if (splicer.changed) {
        touchedWitnesses.push(witness);
        invalidateDescendantVariants(unit, witness);
      }
    }
    return transformResultFor(touchedWitnesses);
  },
};
