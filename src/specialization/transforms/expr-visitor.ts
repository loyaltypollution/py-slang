import { ExprNS, StmtNS } from "../../ast-types";

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

/** Recursive expr rewriter. All descent goes through `this.rewrite`, so a
 *  subclass can wrap every node by overriding `rewrite` alone. */
export class DescendingExprVisitor implements ExprNS.Visitor<ExprNS.Expr> {
  rewrite(expr: ExprNS.Expr): ExprNS.Expr {
    return expr.accept(this);
  }

  private descendLeftRight(expr: ExprNS.Binary | ExprNS.Compare | ExprNS.BoolOp): ExprNS.Expr {
    expr.left = this.rewrite(expr.left);
    expr.right = this.rewrite(expr.right);
    return expr;
  }

  private descendArray(exprs: ExprNS.Expr[]): void {
    for (let i = 0; i < exprs.length; i++) exprs[i] = this.rewrite(exprs[i]);
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
    expr.right = this.rewrite(expr.right);
    return expr;
  }
  visitTernaryExpr(expr: ExprNS.Ternary): ExprNS.Expr {
    expr.predicate = this.rewrite(expr.predicate);
    expr.consequent = this.rewrite(expr.consequent);
    expr.alternative = this.rewrite(expr.alternative);
    return expr;
  }
  visitCallExpr(expr: ExprNS.Call): ExprNS.Expr {
    expr.callee = this.rewrite(expr.callee);
    this.descendArray(expr.args);
    return expr;
  }
  visitListExpr(expr: ExprNS.List): ExprNS.Expr {
    this.descendArray(expr.elements);
    return expr;
  }
  visitSubscriptExpr(expr: ExprNS.Subscript): ExprNS.Expr {
    expr.value = this.rewrite(expr.value);
    expr.index = this.rewrite(expr.index);
    return expr;
  }
  visitGroupingExpr(expr: ExprNS.Grouping): ExprNS.Expr {
    expr.expression = this.rewrite(expr.expression);
    return expr;
  }
  visitStarredExpr(expr: ExprNS.Starred): ExprNS.Expr {
    expr.value = this.rewrite(expr.value);
    return expr;
  }
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

/** Replaces any expr whose `id` is in the map with the corresponding node. */
export class IdReplacer extends DescendingExprVisitor {
  changed = false;
  constructor(private readonly replacements: ReadonlyMap<number, ExprNS.Expr>) {
    super();
  }
  rewrite(expr: ExprNS.Expr): ExprNS.Expr {
    const after = super.rewrite(expr);
    const replacement = this.replacements.get(after.id);
    if (replacement === undefined) return after;
    this.changed = true;
    return replacement;
  }
}

/** Walks `stmts` (recursing into compound bodies) and rewrites each
 *  expression-bearing position via `visitor.rewrite`. */
export function rewriteStmtRhs(stmts: StmtNS.Stmt[], visitor: DescendingExprVisitor): void {
  for (const s of stmts) {
    if (s instanceof StmtNS.Assign || s instanceof StmtNS.AnnAssign || s instanceof StmtNS.Assert) {
      s.value = visitor.rewrite(s.value);
    } else if (s instanceof StmtNS.Return) {
      if (s.value) s.value = visitor.rewrite(s.value);
    } else if (s instanceof StmtNS.SimpleExpr) {
      s.expression = visitor.rewrite(s.expression);
    } else if (s instanceof StmtNS.If) {
      s.condition = visitor.rewrite(s.condition);
      rewriteStmtRhs(s.body, visitor);
      if (s.elseBlock) rewriteStmtRhs(s.elseBlock, visitor);
    } else if (s instanceof StmtNS.While) {
      s.condition = visitor.rewrite(s.condition);
      rewriteStmtRhs(s.body, visitor);
    } else if (s instanceof StmtNS.For) {
      s.iter = visitor.rewrite(s.iter);
      rewriteStmtRhs(s.body, visitor);
    } else if (s instanceof StmtNS.FileInput) {
      rewriteStmtRhs(s.statements, visitor);
    }
  }
}
