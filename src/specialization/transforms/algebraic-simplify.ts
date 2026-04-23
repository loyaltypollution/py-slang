// Algebraic simplification — rewrites Binary/BoolOp/Unary using type facts.
// Reads the type lattice (kind mask + sign/bool refinement); no new analysis
// required. Pure wins on identity/annihilator laws.
//
// Witness-aware: every actual simplification computes the deepest load-bearing
// witness among the facts it uses, then publishes at that witness chain.
// Shallower witness groups are published first so deeper forks inherit them in
// the same sweep.

import { ExprNS, StmtNS } from "../../ast-types";
import { TokenType } from "../../tokenizer";
import type { ConstLattice } from "../const-analysis/lattice";
import type { TransformRule } from "../framework/analysis";
import { unitOfBlock, wakeOwningUnit } from "../framework/analysis";
import type { AssumptionChain } from "../framework/assumption-chain";
import { constAnalysis, typeAnalysis } from "../framework/dfa-analyses";
import type { Unit } from "../framework/function-unit";
import type { ProgramTopology } from "../framework/topology";
import { BOOL_BIT, BoolRef, INT_BIT, IntRef, type TypeLattice } from "../type-analysis/lattice";
import { truthiness } from "../type-analysis/transfer";
import { BaseStmtVisitor, deepestWitness, runWitnessSweep, shallowestWitness, walkExprs } from "./witness-utils";

type Witnessed<T> = { value: T; witness: AssumptionChain };
type RewritePlan = { witness: AssumptionChain; replacement: ExprNS.Expr };

function typeInfo(
  chain: AssumptionChain,
  topology: ProgramTopology,
  node: ExprNS.Expr,
): Witnessed<TypeLattice> | undefined {
  return typeAnalysis.perExpr(topology).readMinimal(chain, node.id, () => true);
}

function constInfo(
  chain: AssumptionChain,
  topology: ProgramTopology,
  node: ExprNS.Expr,
): Witnessed<ConstLattice> | undefined {
  return constAnalysis.perExpr(topology).readMinimal(chain, node.id, () => true);
}

function pureIntWitness(info: Witnessed<TypeLattice> | undefined): AssumptionChain | undefined {
  return info !== undefined && info.value.kinds === INT_BIT ? info.witness : undefined;
}

function boolWitness(info: Witnessed<TypeLattice> | undefined): AssumptionChain | undefined {
  return info !== undefined && info.value.kinds === BOOL_BIT ? info.witness : undefined;
}

function intZeroWitness(
  type: Witnessed<TypeLattice> | undefined,
  konst: Witnessed<ConstLattice> | undefined,
): AssumptionChain | undefined {
  return shallowestWitness(
    type !== undefined && type.value.kinds === INT_BIT && type.value.intRef === IntRef.Zero
      ? type.witness
      : undefined,
    konst !== undefined && konst.value.tag === "const" && konst.value.value === 0
      ? konst.witness
      : undefined,
  );
}

function intOneWitness(konst: Witnessed<ConstLattice> | undefined): AssumptionChain | undefined {
  return konst !== undefined && konst.value.tag === "const" && konst.value.value === 1
    ? konst.witness
    : undefined;
}

function truthWitness(
  type: Witnessed<TypeLattice> | undefined,
  wanted: BoolRef,
): AssumptionChain | undefined {
  if (type === undefined) return undefined;
  return truthiness(type.value) === wanted ? type.witness : undefined;
}

function unwrapGrouping(e: ExprNS.Expr): ExprNS.Expr {
  while (e instanceof ExprNS.Grouping) e = e.expression;
  return e;
}

// `x` is safe to drop (purely readable) if it's a Literal, Variable, None,
// or BigInt. Calls, subscripts, arithmetic subexpressions etc. may
// side-effect or throw, so `x * 0 → 0` is unsound against them.
function isSafeToDrop(e: ExprNS.Expr): boolean {
  const u = unwrapGrouping(e);
  return (
    u instanceof ExprNS.Literal ||
    u instanceof ExprNS.BigIntLiteral ||
    u instanceof ExprNS.Variable ||
    u instanceof ExprNS.None
  );
}

function zeroLiteralLike(e: ExprNS.Expr): ExprNS.Literal {
  return new ExprNS.Literal(e.startToken, e.endToken, 0 as unknown as number);
}

function rewritePlan(
  chain: AssumptionChain,
  topology: ProgramTopology,
  expr: ExprNS.Expr,
): RewritePlan | undefined {
  if (expr instanceof ExprNS.Binary) {
    const lt = typeInfo(chain, topology, expr.left);
    const rt = typeInfo(chain, topology, expr.right);
    const lc = constInfo(chain, topology, expr.left);
    const rc = constInfo(chain, topology, expr.right);

    const leftPureInt = pureIntWitness(lt);
    const rightPureInt = pureIntWitness(rt);
    const rightZero = intZeroWitness(rt, rc);
    const leftZero = intZeroWitness(lt, lc);
    const rightOne = intOneWitness(rc);
    const leftOne = intOneWitness(lc);

    switch (expr.operator.type) {
      case TokenType.PLUS:
        if (leftPureInt !== undefined && rightZero !== undefined) {
          return { witness: deepestWitness(leftPureInt, rightZero)!, replacement: expr.left };
        }
        if (leftZero !== undefined && rightPureInt !== undefined) {
          return { witness: deepestWitness(leftZero, rightPureInt)!, replacement: expr.right };
        }
        break;
      case TokenType.MINUS:
        if (leftPureInt !== undefined && rightZero !== undefined) {
          return { witness: deepestWitness(leftPureInt, rightZero)!, replacement: expr.left };
        }
        break;
      case TokenType.STAR:
        if (leftPureInt !== undefined && rightOne !== undefined) {
          return { witness: deepestWitness(leftPureInt, rightOne)!, replacement: expr.left };
        }
        if (leftOne !== undefined && rightPureInt !== undefined) {
          return { witness: deepestWitness(leftOne, rightPureInt)!, replacement: expr.right };
        }
        // x * 0 → 0 : only when the dropped side is side-effect-free AND
        // statically integer (float NaN/inf, complex 0j semantics, str*0
        // all break the rewrite).
        if (leftPureInt !== undefined && rightZero !== undefined && isSafeToDrop(expr.left)) {
          return {
            witness: deepestWitness(leftPureInt, rightZero)!,
            replacement: zeroLiteralLike(expr),
          };
        }
        if (leftZero !== undefined && rightPureInt !== undefined && isSafeToDrop(expr.right)) {
          return {
            witness: deepestWitness(leftZero, rightPureInt)!,
            replacement: zeroLiteralLike(expr),
          };
        }
        break;
      case TokenType.DOUBLESLASH:
        if (leftPureInt !== undefined && rightOne !== undefined) {
          return { witness: deepestWitness(leftPureInt, rightOne)!, replacement: expr.left };
        }
        break;
    }
    return undefined;
  }

  if (expr instanceof ExprNS.BoolOp) {
    const lt = typeInfo(chain, topology, expr.left);
    if (expr.operator.type === TokenType.AND) {
      const falseWitness = truthWitness(lt, BoolRef.False);
      if (falseWitness !== undefined) return { witness: falseWitness, replacement: expr.left };
      const trueWitness = truthWitness(lt, BoolRef.True);
      if (trueWitness !== undefined) return { witness: trueWitness, replacement: expr.right };
    } else if (expr.operator.type === TokenType.OR) {
      const trueWitness = truthWitness(lt, BoolRef.True);
      if (trueWitness !== undefined) return { witness: trueWitness, replacement: expr.left };
      const falseWitness = truthWitness(lt, BoolRef.False);
      if (falseWitness !== undefined) return { witness: falseWitness, replacement: expr.right };
    }
    return undefined;
  }

  if (expr instanceof ExprNS.Unary) {
    const inner = unwrapGrouping(expr.right);
    if (
      expr.operator.type === TokenType.MINUS &&
      inner instanceof ExprNS.Unary &&
      inner.operator.type === TokenType.MINUS
    ) {
      return { witness: chain, replacement: inner.right };
    }
    if (
      expr.operator.type === TokenType.NOT &&
      inner instanceof ExprNS.Unary &&
      inner.operator.type === TokenType.NOT
    ) {
      const body = inner.right;
      const bodyBool = boolWitness(typeInfo(chain, topology, body));
      if (bodyBool !== undefined) return { witness: bodyBool, replacement: body };
    }
  }

  return undefined;
}

function collectWitnesses(
  chain: AssumptionChain,
  topology: ProgramTopology,
  stmts: readonly StmtNS.Stmt[],
  out: Set<AssumptionChain>,
): void {
  walkExprs(stmts, (expr) => {
    const plan = rewritePlan(chain, topology, expr);
    if (plan !== undefined) out.add(plan.witness);
  });
}

class AlgebraicSimplifyVisitor implements ExprNS.Visitor<ExprNS.Expr> {
  changed = false;
  constructor(
    private readonly chain: AssumptionChain,
    private readonly topology: ProgramTopology,
  ) {}

  rewrite(expr: ExprNS.Expr): ExprNS.Expr {
    return expr.accept(this);
  }

  private maybeRewrite(expr: ExprNS.Expr): ExprNS.Expr {
    const plan = rewritePlan(this.chain, this.topology, expr);
    if (plan === undefined || plan.witness !== this.chain) return expr;
    this.changed = true;
    return plan.replacement;
  }

  visitBinaryExpr(expr: ExprNS.Binary): ExprNS.Expr {
    expr.left = expr.left.accept(this);
    expr.right = expr.right.accept(this);
    return this.maybeRewrite(expr);
  }

  visitBoolOpExpr(expr: ExprNS.BoolOp): ExprNS.Expr {
    expr.left = expr.left.accept(this);
    expr.right = expr.right.accept(this);
    return this.maybeRewrite(expr);
  }

  visitUnaryExpr(expr: ExprNS.Unary): ExprNS.Expr {
    expr.right = expr.right.accept(this);
    return this.maybeRewrite(expr);
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
    for (let i = 0; i < expr.elements.length; i++) expr.elements[i] = expr.elements[i].accept(this);
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

class AlgebraicSimplifyStmtVisitor extends BaseStmtVisitor {
  private readonly exprVisitor: AlgebraicSimplifyVisitor;

  constructor(chain: AssumptionChain, topology: ProgramTopology) {
    super();
    this.exprVisitor = new AlgebraicSimplifyVisitor(chain, topology);
  }

  get changed(): boolean {
    return this.exprVisitor.changed;
  }

  private rewriteExpr(expr: ExprNS.Expr): ExprNS.Expr {
    return this.exprVisitor.rewrite(expr);
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
}

export const algebraicSimplifyRule: TransformRule = {
  bind(wl) {
    wl.onTransformFactDirty(
      algebraicSimplifyRule,
      typeAnalysis.facts,
      wakeOwningUnit(unitOfBlock),
    );
  },
  sweep(unit: Unit, chain: AssumptionChain, topology: ProgramTopology): boolean {
    const witnesses = new Set<AssumptionChain>();
    collectWitnesses(chain, topology, chain.visibleBody(unit), witnesses);
    return runWitnessSweep(
      unit,
      witnesses,
      (witness) => new AlgebraicSimplifyStmtVisitor(witness, topology),
    );
  },
};
