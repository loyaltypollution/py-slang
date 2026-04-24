// Algebraic simplification on Binary/BoolOp/Unary using type + const facts.
// Identity/annihilator laws only. Witness-aware: each rewrite publishes at
// the deepest witness among the facts it uses.

import { ExprNS } from "../../ast-types";
import { TokenType } from "../../tokenizer";
import {
  BOOL_BIT,
  BoolRef,
  constAnalysis,
  type ConstLattice,
  INT_BIT,
  IntRef,
  truthiness,
  typeAnalysis,
  type TypeLattice,
} from "../analysis";
import type { TransformRule } from "../framework/analysis";
import { unitOfBlock, wakeOwningUnit } from "../framework/analysis";
import type { AssumptionChain } from "../assumption/chain";
import { visibleBody } from "../speculation/assumption-bodies";
import type { Unit } from "../framework/function-unit";
import type { ProgramTopology } from "../framework/topology";
import {
  DescendingExprVisitor,
  ExprDrivenStmtVisitor,
  runWitnessSweep,
  walkExprs,
  type Witnessed,
} from "./witness-utils";

function deepestWitness(
  ...witnesses: ReadonlyArray<AssumptionChain | undefined>
): AssumptionChain | undefined {
  let chosen: AssumptionChain | undefined;
  for (const w of witnesses) {
    if (w !== undefined && (chosen === undefined || w.depth > chosen.depth)) chosen = w;
  }
  return chosen;
}

function shallowestWitness(
  ...witnesses: ReadonlyArray<AssumptionChain | undefined>
): AssumptionChain | undefined {
  let chosen: AssumptionChain | undefined;
  for (const w of witnesses) {
    if (w !== undefined && (chosen === undefined || w.depth < chosen.depth)) chosen = w;
  }
  return chosen;
}

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
  return info?.value.kinds === INT_BIT ? info.witness : undefined;
}

function boolWitness(info: Witnessed<TypeLattice> | undefined): AssumptionChain | undefined {
  return info?.value.kinds === BOOL_BIT ? info.witness : undefined;
}

function intZeroWitness(
  type: Witnessed<TypeLattice> | undefined,
  konst: Witnessed<ConstLattice> | undefined,
): AssumptionChain | undefined {
  const fromType =
    type?.value.kinds === INT_BIT && type.value.intRef === IntRef.Zero ? type.witness : undefined;
  const fromConst =
    konst?.value.tag === "const" && konst.value.value === 0 ? konst.witness : undefined;
  return shallowestWitness(fromType, fromConst);
}

function intOneWitness(konst: Witnessed<ConstLattice> | undefined): AssumptionChain | undefined {
  return konst?.value.tag === "const" && konst.value.value === 1 ? konst.witness : undefined;
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

function planWhen(
  a: AssumptionChain | undefined,
  b: AssumptionChain | undefined,
  replacement: ExprNS.Expr,
): RewritePlan | undefined {
  if (a === undefined || b === undefined) return undefined;
  return { witness: deepestWitness(a, b)!, replacement };
}

function planBinary(
  chain: AssumptionChain,
  topology: ProgramTopology,
  expr: ExprNS.Binary,
): RewritePlan | undefined {
  const lt = typeInfo(chain, topology, expr.left);
  const rt = typeInfo(chain, topology, expr.right);
  const lc = constInfo(chain, topology, expr.left);
  const rc = constInfo(chain, topology, expr.right);

  const leftPureInt = pureIntWitness(lt);
  const rightPureInt = pureIntWitness(rt);
  const leftZero = intZeroWitness(lt, lc);
  const rightZero = intZeroWitness(rt, rc);
  const leftOne = intOneWitness(lc);
  const rightOne = intOneWitness(rc);

  switch (expr.operator.type) {
    case TokenType.PLUS:
      // x + 0 → x ; 0 + x → x
      return (
        planWhen(leftPureInt, rightZero, expr.left) ??
        planWhen(leftZero, rightPureInt, expr.right)
      );
    case TokenType.MINUS:
      // x - 0 → x
      return planWhen(leftPureInt, rightZero, expr.left);
    case TokenType.STAR: {
      // x * 1 → x ; 1 * x → x
      const oneIdent =
        planWhen(leftPureInt, rightOne, expr.left) ??
        planWhen(leftOne, rightPureInt, expr.right);
      if (oneIdent !== undefined) return oneIdent;
      // x * 0 → 0 : only when the dropped side is side-effect-free AND statically int.
      const zero = new ExprNS.Literal(expr.startToken, expr.endToken, 0);
      if (isSafeToDrop(expr.left)) {
        const plan = planWhen(leftPureInt, rightZero, zero);
        if (plan !== undefined) return plan;
      }
      if (isSafeToDrop(expr.right)) {
        const plan = planWhen(leftZero, rightPureInt, zero);
        if (plan !== undefined) return plan;
      }
      return undefined;
    }
    case TokenType.DOUBLESLASH:
      // x // 1 → x
      return planWhen(leftPureInt, rightOne, expr.left);
    default:
      return undefined;
  }
}

function planBoolOp(
  chain: AssumptionChain,
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
  chain: AssumptionChain,
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
  chain: AssumptionChain,
  topology: ProgramTopology,
  expr: ExprNS.Expr,
): RewritePlan | undefined {
  if (expr instanceof ExprNS.Binary) return planBinary(chain, topology, expr);
  if (expr instanceof ExprNS.BoolOp) return planBoolOp(chain, topology, expr);
  if (expr instanceof ExprNS.Unary) return planUnary(chain, topology, expr);
  return undefined;
}

class AlgebraicSimplifyVisitor extends DescendingExprVisitor {
  changed = false;
  constructor(
    private readonly chain: AssumptionChain,
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
    return this.maybeRewrite(super.visitBinaryExpr(expr));
  }

  visitBoolOpExpr(expr: ExprNS.BoolOp): ExprNS.Expr {
    return this.maybeRewrite(super.visitBoolOpExpr(expr));
  }

  visitUnaryExpr(expr: ExprNS.Unary): ExprNS.Expr {
    return this.maybeRewrite(super.visitUnaryExpr(expr));
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
    walkExprs(visibleBody(unit, chain), (expr) => {
      const plan = rewritePlan(chain, topology, expr);
      if (plan !== undefined) witnesses.add(plan.witness);
    });
    return runWitnessSweep(
      unit,
      witnesses,
      (witness) => new ExprDrivenStmtVisitor(new AlgebraicSimplifyVisitor(witness, topology)),
    );
  },
};
