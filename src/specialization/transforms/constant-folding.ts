// Constant folding. Idempotent: rewriting Binary/Compare to Literal removes the "const" fact match.

import { ExprNS, StmtNS } from "../../ast-types";
import type { BasicBlock } from "../framework/cfg";
import { constAnalysisPass } from "../framework/dfa-passes";
import { readExprFact } from "../framework/dfa-factory";
import type { FactStore } from "../framework/fact-store";
import type { FunctionUnit } from "../framework/function-unit";
import { unitSweepRule } from "../framework/transform-rule";

class ConstFoldExprVisitor implements ExprNS.Visitor<ExprNS.Expr> {
  changed = false;

  constructor(
    private readonly factStore: FactStore,
    private readonly unit: FunctionUnit,
  ) {}

  private tryRewrite(expr: ExprNS.Expr): ExprNS.Expr {
    if (!(expr instanceof ExprNS.Binary || expr instanceof ExprNS.Compare)) return expr;
    const block = this.unit.blockOfNode.get(expr.id);
    const cv = readExprFact(this.factStore, constAnalysisPass, block, expr.id);
    if (cv?.tag !== "const") return expr;
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

  constructor(factStore: FactStore, unit: FunctionUnit) {
    this.exprVisitor = new ConstFoldExprVisitor(factStore, unit);
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
  (unit: FunctionUnit, factStore: FactStore) => {
    const v = new ConstFoldStmtVisitor(factStore, unit);
    v.sweep(unit.body);
    return v.changed;
  },
  [{ on: "fact", pass: constAnalysisPass, wake: (_ctx, block) => [(block as BasicBlock).unit] }],
);
