// Constant folding. Idempotent: rewriting Binary/Compare to Literal removes the "const" fact match.
//
// Context-aware: reads const facts via `readExprFactMinimal` from the
// view's bound context. A non-ROOT view sees facts specialized under the
// active speculation; mutation lands on the forked body at that context
// via `bodyAtWitness`.

import { ExprNS, StmtNS } from "../../ast-types";
import type { BasicBlock } from "../framework/cfg";
import { constAnalysis } from "../framework/dfa-analyses";
import type { Unit } from "../framework/function-unit";
import { type TransformFactView, unitSweepRule } from "../framework/transform-rule";
import type { Reading } from "../framework/analysis";
import type { ConstLattice } from "../const-analysis/lattice";

type ConstReading = Reading<ConstLattice>;

function constReading(facts: TransformFactView, nodeId: number): ConstReading | undefined {
  return facts.readExprFactMinimal(constAnalysis, nodeId, cv => cv.tag === "const");
}

/** Scan for the first foldable (Binary/Compare) expression with a const
 *  fact. Used to seed `bodyAtWitness` before any mutation. */
function findSeedReading(facts: TransformFactView, stmts: readonly StmtNS.Stmt[]): ConstReading | undefined {
  for (const s of stmts) {
    const r = scanStmt(facts, s);
    if (r !== undefined) return r;
  }
  return undefined;
}

function scanStmt(facts: TransformFactView, s: StmtNS.Stmt): ConstReading | undefined {
  if (s instanceof StmtNS.Assign || s instanceof StmtNS.AnnAssign) return scanExpr(facts, s.value);
  if (s instanceof StmtNS.Return) return s.value ? scanExpr(facts, s.value) : undefined;
  if (s instanceof StmtNS.If) {
    return scanExpr(facts, s.condition)
      ?? findSeedReading(facts, s.body)
      ?? (s.elseBlock ? findSeedReading(facts, s.elseBlock) : undefined);
  }
  if (s instanceof StmtNS.While) return scanExpr(facts, s.condition) ?? findSeedReading(facts, s.body);
  if (s instanceof StmtNS.For) return scanExpr(facts, s.iter) ?? findSeedReading(facts, s.body);
  if (s instanceof StmtNS.SimpleExpr) return scanExpr(facts, s.expression);
  if (s instanceof StmtNS.Assert) return scanExpr(facts, s.value);
  if (s instanceof StmtNS.FileInput) return findSeedReading(facts, s.statements);
  return undefined;
}

function scanExpr(facts: TransformFactView, e: ExprNS.Expr): ConstReading | undefined {
  if (e instanceof ExprNS.Binary || e instanceof ExprNS.Compare) {
    const r = constReading(facts, e.id);
    if (r !== undefined) return r;
  }
  if (e instanceof ExprNS.Binary || e instanceof ExprNS.Compare || e instanceof ExprNS.BoolOp) {
    return scanExpr(facts, e.left) ?? scanExpr(facts, e.right);
  }
  if (e instanceof ExprNS.Unary) return scanExpr(facts, e.right);
  if (e instanceof ExprNS.Ternary) {
    return scanExpr(facts, e.predicate) ?? scanExpr(facts, e.consequent) ?? scanExpr(facts, e.alternative);
  }
  if (e instanceof ExprNS.Call) {
    const sc = scanExpr(facts, e.callee);
    if (sc !== undefined) return sc;
    for (const a of e.args) { const r = scanExpr(facts, a); if (r !== undefined) return r; }
  }
  if (e instanceof ExprNS.List) {
    for (const el of e.elements) { const r = scanExpr(facts, el); if (r !== undefined) return r; }
  }
  if (e instanceof ExprNS.Subscript) return scanExpr(facts, e.value) ?? scanExpr(facts, e.index);
  if (e instanceof ExprNS.Grouping) return scanExpr(facts, e.expression);
  if (e instanceof ExprNS.Starred) return scanExpr(facts, e.value);
  return undefined;
}

class ConstFoldExprVisitor implements ExprNS.Visitor<ExprNS.Expr> {
  changed = false;

  constructor(
    private readonly facts: TransformFactView,
  ) {}

  private tryRewrite(expr: ExprNS.Expr): ExprNS.Expr {
    if (!(expr instanceof ExprNS.Binary || expr instanceof ExprNS.Compare)) return expr;
    const r = constReading(this.facts, expr.id);
    if (r === undefined) return expr;
    const cv = r.value;
    if (cv.tag !== "const") return expr;
    this.changed = true;
    return new ExprNS.Literal(
      expr.startToken,
      expr.endToken,
      cv.value as true | false | number | string,
    );
  }

  rewrite(expr: ExprNS.Expr): ExprNS.Expr {
    return expr.accept(this);
  }

  visitBinaryExpr(expr: ExprNS.Binary): ExprNS.Expr {
    expr.left = expr.left.accept(this);
    expr.right = expr.right.accept(this);
    return this.tryRewrite(expr);
  }
  visitCompareExpr(expr: ExprNS.Compare): ExprNS.Expr {
    expr.left = expr.left.accept(this);
    expr.right = expr.right.accept(this);
    return this.tryRewrite(expr);
  }
  visitBoolOpExpr(expr: ExprNS.BoolOp): ExprNS.Expr {
    expr.left = expr.left.accept(this);
    expr.right = expr.right.accept(this);
    return expr;
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
    for (let i = 0; i < expr.args.length; i++) {
      expr.args[i] = expr.args[i].accept(this);
    }
    return expr;
  }
  visitListExpr(expr: ExprNS.List): ExprNS.Expr {
    for (let i = 0; i < expr.elements.length; i++) {
      expr.elements[i] = expr.elements[i].accept(this);
    }
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
  // Lambda bodies: separate scope, do not descend.
  visitLambdaExpr(expr: ExprNS.Lambda): ExprNS.Expr {
    return expr;
  }
  visitMultiLambdaExpr(expr: ExprNS.MultiLambda): ExprNS.Expr {
    return expr;
  }
  visitLiteralExpr(expr: ExprNS.Literal): ExprNS.Expr {
    return expr;
  }
  visitBigIntLiteralExpr(expr: ExprNS.BigIntLiteral): ExprNS.Expr {
    return expr;
  }
  visitComplexExpr(expr: ExprNS.Complex): ExprNS.Expr {
    return expr;
  }
  visitVariableExpr(expr: ExprNS.Variable): ExprNS.Expr {
    return expr;
  }
  visitNoneExpr(expr: ExprNS.None): ExprNS.Expr {
    return expr;
  }
}

class ConstFoldStmtVisitor implements StmtNS.Visitor<void> {
  changed = false;
  private readonly exprVisitor: ConstFoldExprVisitor;

  constructor(facts: TransformFactView) {
    this.exprVisitor = new ConstFoldExprVisitor(facts);
  }

  private rewriteExpr(expr: ExprNS.Expr): ExprNS.Expr {
    const result = this.exprVisitor.rewrite(expr);
    if (this.exprVisitor.changed) {
      this.changed = true;
      this.exprVisitor.changed = false;
    }
    return result;
  }

  sweep(stmts: StmtNS.Stmt[]): void {
    for (const stmt of stmts) stmt.accept(this);
  }

  visitAssignStmt(stmt: StmtNS.Assign): void {
    stmt.value = this.rewriteExpr(stmt.value);
  }
  visitAnnAssignStmt(stmt: StmtNS.AnnAssign): void {
    stmt.value = this.rewriteExpr(stmt.value);
  }
  visitIfStmt(stmt: StmtNS.If): void {
    stmt.condition = this.rewriteExpr(stmt.condition);
    this.sweep(stmt.body);
    if (stmt.elseBlock) this.sweep(stmt.elseBlock);
  }
  visitWhileStmt(stmt: StmtNS.While): void {
    stmt.condition = this.rewriteExpr(stmt.condition);
    this.sweep(stmt.body);
  }
  visitForStmt(stmt: StmtNS.For): void {
    stmt.iter = this.rewriteExpr(stmt.iter);
    this.sweep(stmt.body);
  }
  visitReturnStmt(stmt: StmtNS.Return): void {
    if (stmt.value) stmt.value = this.rewriteExpr(stmt.value);
  }
  visitSimpleExprStmt(stmt: StmtNS.SimpleExpr): void {
    stmt.expression = this.rewriteExpr(stmt.expression);
  }
  visitAssertStmt(stmt: StmtNS.Assert): void {
    stmt.value = this.rewriteExpr(stmt.value);
  }
  visitFileInputStmt(stmt: StmtNS.FileInput): void {
    this.sweep(stmt.statements);
  }
  // Nested functions: own unit handles them.
  visitFunctionDefStmt(_stmt: StmtNS.FunctionDef): void {}
  visitPassStmt(_stmt: StmtNS.Pass): void {}
  visitBreakStmt(_stmt: StmtNS.Break): void {}
  visitContinueStmt(_stmt: StmtNS.Continue): void {}
  visitGlobalStmt(_stmt: StmtNS.Global): void {}
  visitNonLocalStmt(_stmt: StmtNS.NonLocal): void {}
  visitFromImportStmt(_stmt: StmtNS.FromImport): void {}
}

export const constantFoldingRule = unitSweepRule(
  "constantFoldingRule",
  (unit: Unit, facts: TransformFactView) => {
    const seed = findSeedReading(facts, unit.body);
    if (seed === undefined) return false;
    const body = facts.bodyAtWitness(unit, seed);
    const v = new ConstFoldStmtVisitor(facts);
    v.sweep(body);
    return v.changed;
  },
  [{ on: "fact", analysis: constAnalysis.facts, wake: (_ctx, block) => [(block as BasicBlock).unit] }],
);
