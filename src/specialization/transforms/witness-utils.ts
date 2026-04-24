import { ExprNS, StmtNS } from "../../ast-types";
import type { AssumptionChain } from "../assumption/chain";
import { forkBody } from "../speculation/assumption-bodies";
import type { Unit } from "../framework/function-unit";

export type Witnessed<T> = { value: T; witness: AssumptionChain };

export function walkExprs(
  stmts: readonly StmtNS.Stmt[],
  onExpr: (expr: ExprNS.Expr) => void,
): void {
  for (const s of stmts) walkStmt(s, onExpr);
}

function walkStmt(s: StmtNS.Stmt, onExpr: (expr: ExprNS.Expr) => void): void {
  if (s instanceof StmtNS.Assign || s instanceof StmtNS.AnnAssign) {
    walkExpr(s.value, onExpr);
  } else if (s instanceof StmtNS.Return) {
    if (s.value) walkExpr(s.value, onExpr);
  } else if (s instanceof StmtNS.If) {
    walkExpr(s.condition, onExpr);
    walkExprs(s.body, onExpr);
    if (s.elseBlock) walkExprs(s.elseBlock, onExpr);
  } else if (s instanceof StmtNS.While) {
    walkExpr(s.condition, onExpr);
    walkExprs(s.body, onExpr);
  } else if (s instanceof StmtNS.For) {
    walkExpr(s.iter, onExpr);
    walkExprs(s.body, onExpr);
  } else if (s instanceof StmtNS.SimpleExpr) {
    walkExpr(s.expression, onExpr);
  } else if (s instanceof StmtNS.Assert) {
    walkExpr(s.value, onExpr);
  } else if (s instanceof StmtNS.FileInput) {
    walkExprs(s.statements, onExpr);
  }
}

export function walkExpr(e: ExprNS.Expr, onExpr: (expr: ExprNS.Expr) => void): void {
  onExpr(e);
  if (e instanceof ExprNS.Binary || e instanceof ExprNS.Compare || e instanceof ExprNS.BoolOp) {
    walkExpr(e.left, onExpr);
    walkExpr(e.right, onExpr);
  } else if (e instanceof ExprNS.Unary) {
    walkExpr(e.right, onExpr);
  } else if (e instanceof ExprNS.Ternary) {
    walkExpr(e.predicate, onExpr);
    walkExpr(e.consequent, onExpr);
    walkExpr(e.alternative, onExpr);
  } else if (e instanceof ExprNS.Call) {
    walkExpr(e.callee, onExpr);
    for (const a of e.args) walkExpr(a, onExpr);
  } else if (e instanceof ExprNS.List) {
    for (const el of e.elements) walkExpr(el, onExpr);
  } else if (e instanceof ExprNS.Subscript) {
    walkExpr(e.value, onExpr);
    walkExpr(e.index, onExpr);
  } else if (e instanceof ExprNS.Grouping) {
    walkExpr(e.expression, onExpr);
  } else if (e instanceof ExprNS.Starred) {
    walkExpr(e.value, onExpr);
  }
}

export abstract class BaseStmtVisitor implements StmtNS.Visitor<void> {
  abstract visitIfStmt(stmt: StmtNS.If): void;
  abstract visitWhileStmt(stmt: StmtNS.While): void;
  abstract visitForStmt(stmt: StmtNS.For): void;
  abstract visitFileInputStmt(stmt: StmtNS.FileInput): void;
  visitFunctionDefStmt(_stmt: StmtNS.FunctionDef): void {}
  visitAssignStmt(_stmt: StmtNS.Assign): void {}
  visitAnnAssignStmt(_stmt: StmtNS.AnnAssign): void {}
  visitReturnStmt(_stmt: StmtNS.Return): void {}
  visitSimpleExprStmt(_stmt: StmtNS.SimpleExpr): void {}
  visitAssertStmt(_stmt: StmtNS.Assert): void {}
  visitPassStmt(_stmt: StmtNS.Pass): void {}
  visitBreakStmt(_stmt: StmtNS.Break): void {}
  visitContinueStmt(_stmt: StmtNS.Continue): void {}
  visitGlobalStmt(_stmt: StmtNS.Global): void {}
  visitNonLocalStmt(_stmt: StmtNS.NonLocal): void {}
  visitFromImportStmt(_stmt: StmtNS.FromImport): void {}
}

export class DescendingExprVisitor implements ExprNS.Visitor<ExprNS.Expr> {
  rewrite(expr: ExprNS.Expr): ExprNS.Expr {
    return expr.accept(this);
  }

  private descendLeftRight(expr: ExprNS.Binary | ExprNS.Compare | ExprNS.BoolOp): ExprNS.Expr {
    expr.left = expr.left.accept(this);
    expr.right = expr.right.accept(this);
    return expr;
  }

  private descendArray(exprs: ExprNS.Expr[]): void {
    for (let i = 0; i < exprs.length; i++) exprs[i] = exprs[i].accept(this);
  }

  visitBinaryExpr(expr: ExprNS.Binary): ExprNS.Expr {
    return this.descendLeftRight(expr);
  }
  visitCompareExpr(expr: ExprNS.Compare): ExprNS.Expr {
    return this.descendLeftRight(expr);
  }
  visitBoolOpExpr(expr: ExprNS.BoolOp): ExprNS.Expr {
    return this.descendLeftRight(expr);
  }
  visitUnaryExpr(expr: ExprNS.Unary): ExprNS.Expr {
    expr.right = expr.right.accept(this);
    return expr;
  }
  visitTernaryExpr(expr: ExprNS.Ternary): ExprNS.Expr {
    expr.predicate = expr.predicate.accept(this);
    expr.consequent = expr.consequent.accept(this);
    expr.alternative = expr.alternative.accept(this);
    return expr;
  }
  visitCallExpr(expr: ExprNS.Call): ExprNS.Expr {
    expr.callee = expr.callee.accept(this);
    this.descendArray(expr.args);
    return expr;
  }
  visitListExpr(expr: ExprNS.List): ExprNS.Expr {
    this.descendArray(expr.elements);
    return expr;
  }
  visitSubscriptExpr(expr: ExprNS.Subscript): ExprNS.Expr {
    expr.value = expr.value.accept(this);
    expr.index = expr.index.accept(this);
    return expr;
  }
  visitGroupingExpr(expr: ExprNS.Grouping): ExprNS.Expr {
    expr.expression = expr.expression.accept(this);
    return expr;
  }
  visitStarredExpr(expr: ExprNS.Starred): ExprNS.Expr {
    expr.value = expr.value.accept(this);
    return expr;
  }
  visitLambdaExpr(expr: ExprNS.Lambda): ExprNS.Expr { return expr; }
  visitMultiLambdaExpr(expr: ExprNS.MultiLambda): ExprNS.Expr { return expr; }
  visitLiteralExpr(expr: ExprNS.Literal): ExprNS.Expr { return expr; }
  visitBigIntLiteralExpr(expr: ExprNS.BigIntLiteral): ExprNS.Expr { return expr; }
  visitComplexExpr(expr: ExprNS.Complex): ExprNS.Expr { return expr; }
  visitVariableExpr(expr: ExprNS.Variable): ExprNS.Expr { return expr; }
  visitNoneExpr(expr: ExprNS.None): ExprNS.Expr { return expr; }
}

export function runWitnessSweep(
  unit: Unit,
  witnesses: Iterable<AssumptionChain>,
  makeVisitor: (witness: AssumptionChain) => {
    readonly changed: boolean;
    sweep(body: StmtNS.Stmt[]): void;
  },
): boolean {
  const ordered = Array.from(witnesses).sort((a, b) => a.depth - b.depth);
  let changed = false;
  for (const witness of ordered) {
    const body = forkBody(unit, witness);
    const v = makeVisitor(witness);
    v.sweep(body);
    changed = v.changed || changed;
  }
  return changed;
}

export class ExprDrivenStmtVisitor<V extends DescendingExprVisitor & { changed: boolean }>
  extends BaseStmtVisitor
{
  constructor(readonly exprVisitor: V) {
    super();
  }

  get changed(): boolean {
    return this.exprVisitor.changed;
  }

  sweep(stmts: StmtNS.Stmt[]): void {
    for (const stmt of stmts) stmt.accept(this);
  }

  private rewrite(e: ExprNS.Expr): ExprNS.Expr {
    return this.exprVisitor.rewrite(e);
  }

  visitAssignStmt(stmt: StmtNS.Assign): void {
    stmt.value = this.rewrite(stmt.value);
  }
  visitAnnAssignStmt(stmt: StmtNS.AnnAssign): void {
    stmt.value = this.rewrite(stmt.value);
  }
  visitIfStmt(stmt: StmtNS.If): void {
    stmt.condition = this.rewrite(stmt.condition);
    this.sweep(stmt.body);
    if (stmt.elseBlock) this.sweep(stmt.elseBlock);
  }
  visitWhileStmt(stmt: StmtNS.While): void {
    stmt.condition = this.rewrite(stmt.condition);
    this.sweep(stmt.body);
  }
  visitForStmt(stmt: StmtNS.For): void {
    stmt.iter = this.rewrite(stmt.iter);
    this.sweep(stmt.body);
  }
  visitReturnStmt(stmt: StmtNS.Return): void {
    if (stmt.value) stmt.value = this.rewrite(stmt.value);
  }
  visitSimpleExprStmt(stmt: StmtNS.SimpleExpr): void {
    stmt.expression = this.rewrite(stmt.expression);
  }
  visitAssertStmt(stmt: StmtNS.Assert): void {
    stmt.value = this.rewrite(stmt.value);
  }
  visitFileInputStmt(stmt: StmtNS.FileInput): void {
    this.sweep(stmt.statements);
  }
}
