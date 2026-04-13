// src/specialization/transforms/constant-folding.ts
//
// Constant folding (PR-6d). The legacy `ConstantFoldingRule` class (an
// `ExprTransformRule` in `worklist.transforms`) has been demolished this
// PR: its match+apply logic now lives inside `constantFoldingRule.transfer`
// (see `../framework/migrated-passes.ts`), which calls
// `applyConstantFoldingSweep(unit)` below.
//
// Fires whenever `constAnalysisPass` or `structuralPass` produce a
// lattice-change for the unit, plus an explicit initial-converge seed
// from `worklist.processTransform` (same seeding pattern as PR-6c
// dead-branch).
//
// Idempotence: once a Binary/Compare has been rewritten to a `Literal`,
// the match predicate returns false on the replacement (Literal is not a
// Binary/Compare) — re-entry on an already-converged body is a no-op
// sweep. The top-only `"fired"` lattice adds a second gate: rewriting
// `"fired"` on the same key equals → no onChange → no downstream consumer
// wakes spuriously.

import { ExprNS, StmtNS } from "../../ast-types";
import type { HintStore } from "../framework/hint";
import type { ConstLattice } from "../const-analysis/lattice";
import type { FunctionUnit } from "../framework/function-unit";

/** Does this expression have a statically-known constant value that we can fold? */
function matchesExpr(expr: ExprNS.Expr, hints: HintStore): boolean {
  if (!(expr instanceof ExprNS.Binary || expr instanceof ExprNS.Compare)) return false;
  return hints.get(expr)?.constVal?.tag === "const";
}

/** Replace a folded Binary/Compare with the corresponding Literal. */
function applyExpr(expr: ExprNS.Expr, hints: HintStore): ExprNS.Expr {
  const cv = hints.get(expr)!.constVal as ConstLattice & { tag: "const" };
  return new ExprNS.Literal(
    expr.startToken,
    expr.endToken,
    cv.value as true | false | number | string,
  );
}

/**
 * Bottom-up expression rewriter specialised for constant folding.
 * Mirrors the generic `ExprRewriteVisitor` in `../framework/transform.ts`
 * but inlined so the legacy `ExprTransformRule` interface is no longer
 * required for this transform.
 */
class ConstFoldExprVisitor implements ExprNS.Visitor<ExprNS.Expr> {
  changed = false;

  constructor(private readonly hints: HintStore) {}

  private tryRewrite(expr: ExprNS.Expr): ExprNS.Expr {
    if (matchesExpr(expr, this.hints)) {
      this.changed = true;
      return applyExpr(expr, this.hints);
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

/**
 * Statement-level walker that drives the expression rewriter at every
 * expression slot. Mirrors `TransformApplyVisitor` in
 * `../framework/transform.ts` restricted to expression rewrites; function
 * bodies are skipped (each unit is optimised independently).
 */
class ConstFoldStmtVisitor implements StmtNS.Visitor<void> {
  changed = false;
  private readonly exprVisitor: ConstFoldExprVisitor;

  constructor(hints: HintStore) {
    this.exprVisitor = new ConstFoldExprVisitor(hints);
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
export function applyConstantFoldingSweep(unit: FunctionUnit): boolean {
  const v = new ConstFoldStmtVisitor(unit.hints);
  v.sweep(unit.body);
  return v.changed;
}
