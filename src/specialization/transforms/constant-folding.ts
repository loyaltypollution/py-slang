// Constant folding. Idempotent: once a Binary/Compare is rewritten to a
// Literal, `matchesExpr` returns false on the replacement, so re-entry on
// a converged body is a no-op sweep.

import { ExprNS, StmtNS } from "../../ast-types";
import { constAnalysisPass } from "../const-analysis/analysis";
import type { ConstLattice } from "../const-analysis/lattice";
import type { FactStore } from "../framework/fact-store";
import type { FunctionUnit } from "../framework/function-unit";
import { unitSweepRule } from "../framework/transform-rule";

/** Does this expression have a statically-known constant value that we can fold? */
function matchesExpr(expr: ExprNS.Expr, factStore: FactStore): boolean {
  if (!(expr instanceof ExprNS.Binary || expr instanceof ExprNS.Compare)) return false;
  return factStore.tryRead(constAnalysisPass, expr.id)?.tag === "const";
}

/** Replace a folded Binary/Compare with the corresponding Literal. */
function applyExpr(expr: ExprNS.Expr, factStore: FactStore): ExprNS.Expr {
  const cv = factStore.tryRead(constAnalysisPass, expr.id) as ConstLattice & { tag: "const" };
  return new ExprNS.Literal(
    expr.startToken,
    expr.endToken,
    cv.value as true | false | number | string,
  );
}

class ConstFoldExprVisitor implements ExprNS.Visitor<ExprNS.Expr> {
  changed = false;

  constructor(private readonly factStore: FactStore) {}

  private tryRewrite(expr: ExprNS.Expr): ExprNS.Expr {
    if (matchesExpr(expr, this.factStore)) {
      this.changed = true;
      return applyExpr(expr, this.factStore);
    }
    return expr;
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
    return this.tryRewrite(expr);
  }
  visitUnaryExpr(expr: ExprNS.Unary): ExprNS.Expr {
    expr.right = expr.right.accept(this);
    return this.tryRewrite(expr);
  }
  visitTernaryExpr(expr: ExprNS.Ternary): ExprNS.Expr {
    expr.predicate = expr.predicate.accept(this);
    expr.consequent = expr.consequent.accept(this);
    expr.alternative = expr.alternative.accept(this);
    return this.tryRewrite(expr);
  }
  visitCallExpr(expr: ExprNS.Call): ExprNS.Expr {
    expr.callee = expr.callee.accept(this);
    for (let i = 0; i < expr.args.length; i++) {
      expr.args[i] = expr.args[i].accept(this);
    }
    return this.tryRewrite(expr);
  }
  visitListExpr(expr: ExprNS.List): ExprNS.Expr {
    for (let i = 0; i < expr.elements.length; i++) {
      expr.elements[i] = expr.elements[i].accept(this);
    }
    return this.tryRewrite(expr);
  }
  visitSubscriptExpr(expr: ExprNS.Subscript): ExprNS.Expr {
    expr.value = expr.value.accept(this);
    expr.index = expr.index.accept(this);
    return this.tryRewrite(expr);
  }
  visitGroupingExpr(expr: ExprNS.Grouping): ExprNS.Expr {
    expr.expression = expr.expression.accept(this);
    return this.tryRewrite(expr);
  }
  visitStarredExpr(expr: ExprNS.Starred): ExprNS.Expr {
    expr.value = expr.value.accept(this);
    return this.tryRewrite(expr);
  }
  // Lambda bodies are a separate scope — do not descend (matches DFA boundary).
  visitLambdaExpr(expr: ExprNS.Lambda): ExprNS.Expr {
    return this.tryRewrite(expr);
  }
  visitMultiLambdaExpr(expr: ExprNS.MultiLambda): ExprNS.Expr {
    return this.tryRewrite(expr);
  }
  // Leaves
  visitLiteralExpr(expr: ExprNS.Literal): ExprNS.Expr {
    return this.tryRewrite(expr);
  }
  visitBigIntLiteralExpr(expr: ExprNS.BigIntLiteral): ExprNS.Expr {
    return this.tryRewrite(expr);
  }
  visitComplexExpr(expr: ExprNS.Complex): ExprNS.Expr {
    return this.tryRewrite(expr);
  }
  visitVariableExpr(expr: ExprNS.Variable): ExprNS.Expr {
    return this.tryRewrite(expr);
  }
  visitNoneExpr(expr: ExprNS.None): ExprNS.Expr {
    return this.tryRewrite(expr);
  }
}

// Function bodies are skipped — each unit is optimised independently.
class ConstFoldStmtVisitor implements StmtNS.Visitor<void> {
  changed = false;
  private readonly exprVisitor: ConstFoldExprVisitor;

  constructor(factStore: FactStore) {
    this.exprVisitor = new ConstFoldExprVisitor(factStore);
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
  // Function bodies are optimised independently by their own units.
  visitFunctionDefStmt(_stmt: StmtNS.FunctionDef): void {}
  visitPassStmt(_stmt: StmtNS.Pass): void {}
  visitBreakStmt(_stmt: StmtNS.Break): void {}
  visitContinueStmt(_stmt: StmtNS.Continue): void {}
  visitGlobalStmt(_stmt: StmtNS.Global): void {}
  visitNonLocalStmt(_stmt: StmtNS.NonLocal): void {}
  visitFromImportStmt(_stmt: StmtNS.FromImport): void {}
}

/**
 * Sweep `unit.body` for Binary/Compare expressions whose `constVal` hint
 * has collapsed to a statically-known constant and rewrite them in place
 * to `Literal` nodes. Returns `true` iff a mutation occurred. Called from
 * `constantFoldingRule.transfer`; the worklist marks the scope structurally
 * dirty and bumps the `structuralPass` version when this returns `true`.
 */
export function applyConstantFoldingSweep(unit: FunctionUnit, factStore: FactStore): boolean {
  const v = new ConstFoldStmtVisitor(factStore);
  v.sweep(unit.body);
  return v.changed;
}

export const constantFoldingRule = unitSweepRule(
  "constantFoldingRule",
  [constAnalysisPass],
  applyConstantFoldingSweep,
);
