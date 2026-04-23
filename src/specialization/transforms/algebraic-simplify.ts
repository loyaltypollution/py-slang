// Algebraic simplification on Binary/BoolOp/Unary using type + const facts.
// Identity/annihilator laws only. Witness-aware: each rewrite publishes at
// the deepest witness among the facts it uses.

import { ExprNS, StmtNS } from "../../ast-types";
import { TokenType } from "../../tokenizer";
import type { ConstLattice } from "../const-analysis/lattice";
import type { TransformRule } from "../framework/analysis";
import { unitOfBlock, wakeOwningUnit } from "../framework/analysis";
import type { Speculation } from "../framework/assumption-chain";
import { visibleBody } from "../framework/assumption-bodies";
import { constAnalysis, typeAnalysis } from "../framework/dfa-analyses";
import type { Unit } from "../framework/function-unit";
import type { ProgramTopology } from "../framework/topology";
import { BOOL_BIT, BoolRef, INT_BIT, IntRef, type TypeLattice } from "../type-analysis/lattice";
import { truthiness } from "../type-analysis/transfer";
import {
  deepestWitness,
  DescendingExprVisitor,
  RewriteStmtVisitor,
  runWitnessSweep,
  shallowestWitness,
  walkExprs,
} from "./witness-utils";

type Witnessed<T> = { value: T; witness: Speculation };
type RewritePlan = { witness: Speculation; replacement: ExprNS.Expr };

function typeInfo(
  chain: Speculation,
  topology: ProgramTopology,
  node: ExprNS.Expr,
): Witnessed<TypeLattice> | undefined {
  return typeAnalysis.perExpr(topology).readMinimal(chain, node.id, () => true);
}

function constInfo(
  chain: Speculation,
  topology: ProgramTopology,
  node: ExprNS.Expr,
): Witnessed<ConstLattice> | undefined {
  return constAnalysis.perExpr(topology).readMinimal(chain, node.id, () => true);
}

function pureIntWitness(info: Witnessed<TypeLattice> | undefined): Speculation | undefined {
  return info?.value.kinds === INT_BIT ? info.witness : undefined;
}

function boolWitness(info: Witnessed<TypeLattice> | undefined): Speculation | undefined {
  return info?.value.kinds === BOOL_BIT ? info.witness : undefined;
}

function intZeroWitness(
  type: Witnessed<TypeLattice> | undefined,
  konst: Witnessed<ConstLattice> | undefined,
): Speculation | undefined {
  const fromType =
    type?.value.kinds === INT_BIT && type.value.intRef === IntRef.Zero ? type.witness : undefined;
  const fromConst =
    konst?.value.tag === "const" && konst.value.value === 0 ? konst.witness : undefined;
  return shallowestWitness(fromType, fromConst);
}

function intOneWitness(konst: Witnessed<ConstLattice> | undefined): Speculation | undefined {
  return konst?.value.tag === "const" && konst.value.value === 1 ? konst.witness : undefined;
}

function truthWitness(
  type: Witnessed<TypeLattice> | undefined,
  wanted: BoolRef,
): Speculation | undefined {
  if (type === undefined) return undefined;
  return truthiness(type.value) === wanted ? type.witness : undefined;
}

function unwrapGrouping(e: ExprNS.Expr): ExprNS.Expr {
  while (e instanceof ExprNS.Grouping) e = e.expression;
  return e;
}

// `x` is safe to drop (purely readable) if it's a Literal, Variable, None, or
// BigInt. Calls, subscripts, arithmetic etc. may side-effect or throw.
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
  return new ExprNS.Literal(e.startToken, e.endToken, 0);
}

function planBinary(
  chain: Speculation,
  topology: ProgramTopology,
  expr: ExprNS.Binary,
): RewritePlan | undefined {
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
      return undefined;
    case TokenType.MINUS:
      if (leftPureInt !== undefined && rightZero !== undefined) {
        return { witness: deepestWitness(leftPureInt, rightZero)!, replacement: expr.left };
      }
      return undefined;
    case TokenType.STAR:
      if (leftPureInt !== undefined && rightOne !== undefined) {
        return { witness: deepestWitness(leftPureInt, rightOne)!, replacement: expr.left };
      }
      if (leftOne !== undefined && rightPureInt !== undefined) {
        return { witness: deepestWitness(leftOne, rightPureInt)!, replacement: expr.right };
      }
      // x * 0 → 0 : only when dropped side is side-effect-free AND statically int.
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
      return undefined;
    case TokenType.DOUBLESLASH:
      if (leftPureInt !== undefined && rightOne !== undefined) {
        return { witness: deepestWitness(leftPureInt, rightOne)!, replacement: expr.left };
      }
      return undefined;
    default:
      return undefined;
  }
}

function planBoolOp(
  chain: Speculation,
  topology: ProgramTopology,
  expr: ExprNS.BoolOp,
): RewritePlan | undefined {
  const lt = typeInfo(chain, topology, expr.left);
  if (expr.operator.type === TokenType.AND) {
    const falseW = truthWitness(lt, BoolRef.False);
    if (falseW !== undefined) return { witness: falseW, replacement: expr.left };
    const trueW = truthWitness(lt, BoolRef.True);
    if (trueW !== undefined) return { witness: trueW, replacement: expr.right };
  } else if (expr.operator.type === TokenType.OR) {
    const trueW = truthWitness(lt, BoolRef.True);
    if (trueW !== undefined) return { witness: trueW, replacement: expr.left };
    const falseW = truthWitness(lt, BoolRef.False);
    if (falseW !== undefined) return { witness: falseW, replacement: expr.right };
  }
  return undefined;
}

function planUnary(
  chain: Speculation,
  topology: ProgramTopology,
  expr: ExprNS.Unary,
): RewritePlan | undefined {
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
  return undefined;
}

function rewritePlan(
  chain: Speculation,
  topology: ProgramTopology,
  expr: ExprNS.Expr,
): RewritePlan | undefined {
  if (expr instanceof ExprNS.Binary) return planBinary(chain, topology, expr);
  if (expr instanceof ExprNS.BoolOp) return planBoolOp(chain, topology, expr);
  if (expr instanceof ExprNS.Unary) return planUnary(chain, topology, expr);
  return undefined;
}

function collectWitnesses(
  chain: Speculation,
  topology: ProgramTopology,
  stmts: readonly StmtNS.Stmt[],
  out: Set<Speculation>,
): void {
  walkExprs(stmts, (expr) => {
    const plan = rewritePlan(chain, topology, expr);
    if (plan !== undefined) out.add(plan.witness);
  });
}

class AlgebraicSimplifyVisitor extends DescendingExprVisitor {
  changed = false;
  constructor(
    private readonly chain: Speculation,
    private readonly topology: ProgramTopology,
  ) {
    super();
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
}

class AlgebraicSimplifyStmtVisitor extends RewriteStmtVisitor {
  private readonly exprVisitor: AlgebraicSimplifyVisitor;

  constructor(chain: Speculation, topology: ProgramTopology) {
    const exprVisitor = new AlgebraicSimplifyVisitor(chain, topology);
    super((e) => exprVisitor.rewrite(e));
    this.exprVisitor = exprVisitor;
  }

  get changed(): boolean {
    return this.exprVisitor.changed;
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
  sweep(unit: Unit, chain: Speculation, topology: ProgramTopology): boolean {
    const witnesses = new Set<Speculation>();
    collectWitnesses(chain, topology, visibleBody(unit, chain), witnesses);
    return runWitnessSweep(
      unit,
      witnesses,
      (witness) => new AlgebraicSimplifyStmtVisitor(witness, topology),
    );
  },
};
