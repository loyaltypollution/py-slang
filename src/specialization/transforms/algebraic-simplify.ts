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
  return info !== undefined && info.value.kinds === INT_BIT ? info.witness : undefined;
}

function boolWitness(info: Witnessed<TypeLattice> | undefined): Speculation | undefined {
  return info !== undefined && info.value.kinds === BOOL_BIT ? info.witness : undefined;
}

function intZeroWitness(
  type: Witnessed<TypeLattice> | undefined,
  konst: Witnessed<ConstLattice> | undefined,
): Speculation | undefined {
  return shallowestWitness(
    type !== undefined && type.value.kinds === INT_BIT && type.value.intRef === IntRef.Zero
      ? type.witness
      : undefined,
    konst !== undefined && konst.value.tag === "const" && konst.value.value === 0
      ? konst.witness
      : undefined,
  );
}

function intOneWitness(konst: Witnessed<ConstLattice> | undefined): Speculation | undefined {
  return konst !== undefined && konst.value.tag === "const" && konst.value.value === 1
    ? konst.witness
    : undefined;
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
  chain: Speculation,
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
