import { ExprNS, StmtNS } from "../../ast-types";
import type {
  ExprTransformRule,
  TransformRule,
} from "./interfaces";
import type { HintStore } from "./hint";

/**
 * Bottom-up expression rewriter. Each visit method:
 *   1. Recurses into children via accept(this), reassigning the return value
 *   2. Checks if the current node matches the rule
 *   3. Returns the replacement if matched, otherwise the original node
 */
class ExprRewriteVisitor implements ExprNS.Visitor<ExprNS.Expr> {
  changed = false;

  constructor(
    private readonly rule: ExprTransformRule,
    private readonly hints: HintStore,
  ) {}
  // Scope-level rules bypass this visitor entirely; the worklist handles
  // them via `rule.apply(unit)` directly.

  private tryRewrite(expr: ExprNS.Expr): ExprNS.Expr {
    if (this.rule.matches(expr, this.hints)) {
      this.changed = true;
      return this.rule.apply(expr, this.hints);
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
  visitLiteralExpr(expr: ExprNS.Literal): ExprNS.Expr { return this.tryRewrite(expr); }
  visitBigIntLiteralExpr(expr: ExprNS.BigIntLiteral): ExprNS.Expr { return this.tryRewrite(expr); }
  visitComplexExpr(expr: ExprNS.Complex): ExprNS.Expr { return this.tryRewrite(expr); }
  visitVariableExpr(expr: ExprNS.Variable): ExprNS.Expr { return this.tryRewrite(expr); }
  visitNoneExpr(expr: ExprNS.None): ExprNS.Expr { return this.tryRewrite(expr); }
}

/**
 * Statement-level transform visitor. Handles both rule levels:
 *   - Expr rules: rewrites expression children via ExprRewriteVisitor
 *   - Stmt rules: splices matching statements in block arrays
 *
 * Statement recursion uses accept() (visitor dispatch). Array-level splicing
 * is manual because accept() cannot return variable-length replacements.
 */
class TransformApplyVisitor implements StmtNS.Visitor<void> {
  changed = false;
  readonly invalidate = new Set<StmtNS.FileInput | StmtNS.FunctionDef>();

  constructor(
    private readonly rule: TransformRule,
    private readonly hints: HintStore,
  ) {}

  private rewriteExpr(expr: ExprNS.Expr): ExprNS.Expr {
    if (this.rule.level !== "expr") return expr;
    const visitor = new ExprRewriteVisitor(this.rule, this.hints);
    const result = visitor.rewrite(expr);
    if (visitor.changed) this.changed = true;
    return result;
  }

  applyToBlock(stmts: StmtNS.Stmt[]): void {
    if (this.rule.level === "scope") return; // handled by worklist directly
    if (this.rule.level === "stmt") {
      let i = 0;
      while (i < stmts.length) {
        if (this.rule.matches(stmts[i], this.hints)) {
          const original = stmts[i];
          const replacements = this.rule.apply(original, this.hints);
          stmts.splice(i, 1, ...replacements);
          this.changed = true;
          const affected = this.rule.affectedScopes?.(original);
          if (affected) for (const s of affected) this.invalidate.add(s);
        } else {
          stmts[i].accept(this);
          i++;
        }
      }
    } else {
      for (const stmt of stmts) stmt.accept(this);
    }
  }

  visitAssignStmt(stmt: StmtNS.Assign): void {
    stmt.value = this.rewriteExpr(stmt.value);
  }
  visitAnnAssignStmt(stmt: StmtNS.AnnAssign): void {
    stmt.value = this.rewriteExpr(stmt.value);
  }
  visitIfStmt(stmt: StmtNS.If): void {
    stmt.condition = this.rewriteExpr(stmt.condition);
    this.applyToBlock(stmt.body);
    if (stmt.elseBlock) this.applyToBlock(stmt.elseBlock);
  }
  visitWhileStmt(stmt: StmtNS.While): void {
    stmt.condition = this.rewriteExpr(stmt.condition);
    this.applyToBlock(stmt.body);
  }
  visitForStmt(stmt: StmtNS.For): void {
    stmt.iter = this.rewriteExpr(stmt.iter);
    this.applyToBlock(stmt.body);
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
    this.applyToBlock(stmt.statements);
  }
  // Function bodies are optimized independently by optimizeUnit — do not descend.
  visitFunctionDefStmt(_stmt: StmtNS.FunctionDef): void {}
  visitPassStmt(_stmt: StmtNS.Pass): void {}
  visitBreakStmt(_stmt: StmtNS.Break): void {}
  visitContinueStmt(_stmt: StmtNS.Continue): void {}
  visitGlobalStmt(_stmt: StmtNS.Global): void {}
  visitNonLocalStmt(_stmt: StmtNS.NonLocal): void {}
  visitFromImportStmt(_stmt: StmtNS.FromImport): void {}
}

/**
 * Apply one transformation rule to a statement list.
 * Returns `changed` flag plus any additional scopes the rule flagged via
 * `affectedScopes` — the worklist rebuilds those too (used by non-monotone
 * transforms like memoization that mutate a child scope's body from the
 * parent's pass).
 */
export interface TransformPassResult {
  readonly changed: boolean;
  readonly invalidate: ReadonlySet<StmtNS.FileInput | StmtNS.FunctionDef>;
}

export function applyTransformPass(
  stmts: StmtNS.Stmt[],
  rule: TransformRule,
  hints: HintStore,
): TransformPassResult {
  const visitor = new TransformApplyVisitor(rule, hints);
  visitor.applyToBlock(stmts);
  return { changed: visitor.changed, invalidate: visitor.invalidate };
}
