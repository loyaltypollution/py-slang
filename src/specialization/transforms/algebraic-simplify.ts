// Algebraic simplification — rewrites Binary/BoolOp/Unary using type facts.
// Reads the type lattice (kind mask + sign/bool refinement); no new analysis
// required. Pure wins on identity/annihilator laws:
//
//   int  ::  x + 0 → x      x - 0 → x
//             x * 1 → x      x * 0 → 0      x // 1 → x
//             - -x  → x
//   bool ::  (short-circuit, lhs-driven — lhs is still evaluated for its
//             side effects, we just use its truth value to select the arm)
//             falsy-lhs and y → lhs      truthy-lhs and y → y
//             truthy-lhs or  y → lhs     falsy-lhs  or  y → y
//   not (not x) → x  (when x is a known bool)
//
// We do NOT apply laws whose soundness depends on purity of the dropped side
// (e.g. `x * 0 → 0` requires x to be finite; floats with NaN break it — we
// guard on INT_BIT only). Idempotent: every rewrite strictly reduces node
// count or lowers kind complexity.

import { ExprNS, StmtNS } from "../../ast-types";
import { TokenType } from "../../tokens";
import type { BasicBlock } from "../framework/cfg";
import { typeAnalysis, constAnalysis } from "../framework/dfa-analyses";
import { readExprFact } from "../framework/dfa-factory";
import type { Unit } from "../framework/function-unit";
import { type TransformFactView, unitSweepRule } from "../framework/transform-rule";
import type { ConstLattice } from "../const-analysis/lattice";
import {
  INT_BIT,
  BOOL_BIT,
  IntRef,
  BoolRef,
  type TypeLattice,
} from "../type-analysis/lattice";
import { truthiness } from "../type-analysis/transfer";

function unwrapGrouping(e: ExprNS.Expr): ExprNS.Expr {
  while (e instanceof ExprNS.Grouping) e = e.expression;
  return e;
}

function isIntZero(t: TypeLattice | undefined): boolean {
  return t !== undefined && t.kinds === INT_BIT && t.intRef === IntRef.Zero;
}
function isPureInt(t: TypeLattice | undefined): boolean {
  return t !== undefined && t.kinds === INT_BIT;
}

// `x` is safe to drop (purely readable) if it's a Literal, Variable, None,
// or BigInt. Calls, subscripts, arithmetic subexpressions etc. may
// side-effect or throw, so `x * 0 → 0` is unsound against them.
function isSafeToDrop(e: ExprNS.Expr): boolean {
  const u = unwrapGrouping(e);
  return u instanceof ExprNS.Literal ||
    u instanceof ExprNS.BigIntLiteral ||
    u instanceof ExprNS.Variable ||
    u instanceof ExprNS.None;
}

function zeroLiteralLike(e: ExprNS.Expr): ExprNS.Literal {
  return new ExprNS.Literal(e.startToken, e.endToken, 0 as unknown as number);
}

class AlgebraicSimplifyVisitor implements ExprNS.Visitor<ExprNS.Expr> {
  changed = false;
  constructor(
    private readonly factStore: TransformFactView,
  ) {}

  rewrite(expr: ExprNS.Expr): ExprNS.Expr {
    return expr.accept(this);
  }

  private mark<T extends ExprNS.Expr>(e: T): T {
    this.changed = true;
    return e;
  }

  private typeOf(node: ExprNS.Expr): TypeLattice | undefined {
    return readExprFact(this.factStore.topology, typeAnalysis, node.id);
  }
  private constOf(node: ExprNS.Expr): ConstLattice | undefined {
    return readExprFact(this.factStore.topology, constAnalysis, node.id);
  }

  visitBinaryExpr(expr: ExprNS.Binary): ExprNS.Expr {
    expr.left = expr.left.accept(this);
    expr.right = expr.right.accept(this);
    const lt = this.typeOf(expr.left);
    const rt = this.typeOf(expr.right);
    const lc = this.constOf(expr.left);
    const rc = this.constOf(expr.right);

    // Precise identity detectors via the const lattice. The sign lattice
    // cannot distinguish `1` from any other positive, so `x * 1 → x` needs
    // const facts; the sign lattice *can* catch `0` (IntRef.Zero is a
    // singleton), preferred because const-folding often runs first and
    // leaves non-constant expressions whose sign is still known.
    const rIsZeroInt = isIntZero(rt) || (rc?.tag === "const" && rc.value === 0);
    const lIsZeroInt = isIntZero(lt) || (lc?.tag === "const" && lc.value === 0);
    const rIsOneInt = rc?.tag === "const" && rc.value === 1;
    const lIsOneInt = lc?.tag === "const" && lc.value === 1;

    switch (expr.operator.type) {
      case TokenType.PLUS:
        if (isPureInt(lt) && rIsZeroInt) return this.mark(expr.left);
        if (lIsZeroInt && isPureInt(rt)) return this.mark(expr.right);
        break;
      case TokenType.MINUS:
        if (isPureInt(lt) && rIsZeroInt) return this.mark(expr.left);
        break;
      case TokenType.STAR:
        if (isPureInt(lt) && rIsOneInt) return this.mark(expr.left);
        if (lIsOneInt && isPureInt(rt)) return this.mark(expr.right);
        // x * 0 → 0 : only when the dropped side is side-effect-free AND
        // statically integer (float NaN/inf, complex 0j semantics, str*0
        // all break the rewrite).
        if (isPureInt(lt) && rIsZeroInt && isSafeToDrop(expr.left)) {
          return this.mark(zeroLiteralLike(expr));
        }
        if (lIsZeroInt && isPureInt(rt) && isSafeToDrop(expr.right)) {
          return this.mark(zeroLiteralLike(expr));
        }
        break;
      case TokenType.DOUBLESLASH:
        if (isPureInt(lt) && rIsOneInt) return this.mark(expr.left);
        break;
    }
    return expr;
  }

  visitBoolOpExpr(expr: ExprNS.BoolOp): ExprNS.Expr {
    expr.left = expr.left.accept(this);
    expr.right = expr.right.accept(this);
    const lt = this.typeOf(expr.left);
    if (lt !== undefined) {
      const truth = truthiness(lt);
      // Short-circuit identities, safe because we evaluate left for
      // its (possibly side-effectful) expression regardless — the type
      // fact already reflects that.
      if (expr.operator.type === TokenType.AND) {
        if (truth === BoolRef.False) return this.mark(expr.left);
        if (truth === BoolRef.True) return this.mark(expr.right);
      } else if (expr.operator.type === TokenType.OR) {
        if (truth === BoolRef.True) return this.mark(expr.left);
        if (truth === BoolRef.False) return this.mark(expr.right);
      }
    }
    return expr;
  }

  visitUnaryExpr(expr: ExprNS.Unary): ExprNS.Expr {
    expr.right = expr.right.accept(this);
    // Peek through Grouping without losing the wrapper — the parser emits
    // `-(-x)` as Unary(-, Grouping(Unary(-, x))).
    const inner = unwrapGrouping(expr.right);
    if (
      expr.operator.type === TokenType.MINUS &&
      inner instanceof ExprNS.Unary &&
      inner.operator.type === TokenType.MINUS
    ) {
      return this.mark(inner.right);
    }
    if (
      expr.operator.type === TokenType.NOT &&
      inner instanceof ExprNS.Unary &&
      inner.operator.type === TokenType.NOT
    ) {
      const body = inner.right;
      const bodyType = this.typeOf(body);
      if (bodyType !== undefined && bodyType.kinds === BOOL_BIT) {
        return this.mark(body);
      }
    }
    return expr;
  }

  // Descent-only visitors (same pattern as const-folding.ts):
  visitCompareExpr(expr: ExprNS.Compare): ExprNS.Expr {
    expr.left = expr.left.accept(this);
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
    for (let i = 0; i < expr.args.length; i++) expr.args[i] = expr.args[i].accept(this);
    return expr;
  }
  visitListExpr(expr: ExprNS.List): ExprNS.Expr {
    for (let i = 0; i < expr.elements.length; i++)
      expr.elements[i] = expr.elements[i].accept(this);
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

class AlgebraicSimplifyStmtVisitor implements StmtNS.Visitor<void> {
  changed = false;
  private readonly exprVisitor: AlgebraicSimplifyVisitor;

  constructor(factStore: TransformFactView) {
    this.exprVisitor = new AlgebraicSimplifyVisitor(factStore);
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
  visitFunctionDefStmt(_stmt: StmtNS.FunctionDef): void {}
  visitPassStmt(_stmt: StmtNS.Pass): void {}
  visitBreakStmt(_stmt: StmtNS.Break): void {}
  visitContinueStmt(_stmt: StmtNS.Continue): void {}
  visitGlobalStmt(_stmt: StmtNS.Global): void {}
  visitNonLocalStmt(_stmt: StmtNS.NonLocal): void {}
  visitFromImportStmt(_stmt: StmtNS.FromImport): void {}
}

export const algebraicSimplifyRule = unitSweepRule(
  "algebraicSimplifyRule",
  (unit: Unit, factStore: TransformFactView) => {
    const v = new AlgebraicSimplifyStmtVisitor(factStore);
    v.sweep(unit.body);
    return v.changed;
  },
  // Subscribe to `.facts` — this transform reads per-node type lattice values
  // via `readExprFact`. `.env` changes that don't advance `.facts` wouldn't
  // produce new rewrites; watching `.facts` avoids spurious sweeps.
  [{ on: "fact", analysis: typeAnalysis.facts, wake: (_ctx, block) => [(block as BasicBlock).unit] }],
);
