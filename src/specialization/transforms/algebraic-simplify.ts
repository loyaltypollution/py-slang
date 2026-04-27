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
import { functionOfBlock, wakeOwningFunction } from "../program/function-keys";
import type { AssumptionChain } from "../assumption/chain";
import { visibleBody } from "../speculation/assumption-bodies";
import type { Function } from "../program/function";
import type { FunctionRegistry } from "../program/function-keys";
import {
  DescendingExprVisitor,
  ExprDrivenStmtVisitor,
  runWitnessSweep,
  walkExprs,
  type Witnessed,
} from "./witness-utils";

type RewritePlan = { witness: AssumptionChain; replacement: ExprNS.Expr };

function readType(
  chain: AssumptionChain,
  view: FunctionRegistry,
  node: ExprNS.Expr,
): Witnessed<TypeLattice> | undefined {
  return typeAnalysis.perExpr(view).readMinimal(chain, node.id, () => true);
}

function readConst(
  chain: AssumptionChain,
  view: FunctionRegistry,
  node: ExprNS.Expr,
): Witnessed<ConstLattice> | undefined {
  return constAnalysis.perExpr(view).readMinimal(chain, node.id, () => true);
}

function intZeroWitness(
  type: Witnessed<TypeLattice> | undefined,
  konst: Witnessed<ConstLattice> | undefined,
): AssumptionChain | undefined {
  const fromType =
    type?.value.kinds === INT_BIT && type.value.intRef === IntRef.Zero ? type.witness : undefined;
  const fromConst =
    konst?.value.tag === "const" && konst.value.value === 0 ? konst.witness : undefined;
  if (fromType === undefined) return fromConst;
  if (fromConst === undefined) return fromType;
  return fromType.depth < fromConst.depth ? fromType : fromConst;
}

function unwrapGrouping(e: ExprNS.Expr): ExprNS.Expr {
  while (e instanceof ExprNS.Grouping) e = e.expression;
  return e;
}

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
  return { witness: a.depth >= b.depth ? a : b, replacement };
}

function planBinary(
  chain: AssumptionChain,
  view: FunctionRegistry,
  expr: ExprNS.Binary,
): RewritePlan | undefined {
  const lt = readType(chain, view, expr.left);
  const rt = readType(chain, view, expr.right);
  const lc = readConst(chain, view, expr.left);
  const rc = readConst(chain, view, expr.right);

  const leftPureInt = lt?.value.kinds === INT_BIT ? lt.witness : undefined;
  const rightPureInt = rt?.value.kinds === INT_BIT ? rt.witness : undefined;
  const leftZero = intZeroWitness(lt, lc);
  const rightZero = intZeroWitness(rt, rc);
  const leftOne = lc?.value.tag === "const" && lc.value.value === 1 ? lc.witness : undefined;
  const rightOne = rc?.value.tag === "const" && rc.value.value === 1 ? rc.witness : undefined;

  switch (expr.operator.type) {
    case TokenType.PLUS:
      return (
        planWhen(leftPureInt, rightZero, expr.left) ??
        planWhen(leftZero, rightPureInt, expr.right)
      );
    case TokenType.MINUS:
      return planWhen(leftPureInt, rightZero, expr.left);
    case TokenType.STAR: {
      const oneIdent =
        planWhen(leftPureInt, rightOne, expr.left) ??
        planWhen(leftOne, rightPureInt, expr.right);
      if (oneIdent !== undefined) return oneIdent;
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
      return planWhen(leftPureInt, rightOne, expr.left);
    default:
      return undefined;
  }
}

function planBoolOp(
  chain: AssumptionChain,
  view: FunctionRegistry,
  expr: ExprNS.BoolOp,
): RewritePlan | undefined {
  const lt = readType(chain, view, expr.left);
  if (lt === undefined) return undefined;
  const truth = truthiness(lt.value);
  const isAnd = expr.operator.type === TokenType.AND;
  const isOr = expr.operator.type === TokenType.OR;
  if (!isAnd && !isOr) return undefined;
  if (truth === BoolRef.False) {
    return { witness: lt.witness, replacement: isAnd ? expr.left : expr.right };
  }
  if (truth === BoolRef.True) {
    return { witness: lt.witness, replacement: isAnd ? expr.right : expr.left };
  }
  return undefined;
}

function planUnary(
  chain: AssumptionChain,
  view: FunctionRegistry,
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
    const bodyType = readType(chain, view, body);
    if (bodyType?.value.kinds === BOOL_BIT) {
      return { witness: bodyType.witness, replacement: body };
    }
  }
  return undefined;
}

function rewritePlan(
  chain: AssumptionChain,
  view: FunctionRegistry,
  expr: ExprNS.Expr,
): RewritePlan | undefined {
  if (expr instanceof ExprNS.Binary) return planBinary(chain, view, expr);
  if (expr instanceof ExprNS.BoolOp) return planBoolOp(chain, view, expr);
  if (expr instanceof ExprNS.Unary) return planUnary(chain, view, expr);
  return undefined;
}

class AlgebraicSimplifyVisitor extends DescendingExprVisitor {
  changed = false;
  constructor(
    private readonly chain: AssumptionChain,
    private readonly view: FunctionRegistry,
  ) {
    super();
  }

  private maybeRewrite(expr: ExprNS.Expr): ExprNS.Expr {
    const plan = rewritePlan(this.chain, this.view, expr);
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
      wakeOwningFunction(functionOfBlock),
    );
  },
  sweep(unit: Function, chain: AssumptionChain, view: FunctionRegistry): boolean {
    const witnesses = new Set<AssumptionChain>();
    walkExprs(visibleBody(unit, chain), (expr) => {
      const plan = rewritePlan(chain, view, expr);
      if (plan !== undefined) witnesses.add(plan.witness);
    });
    return runWitnessSweep(
      unit,
      witnesses,
      (witness) => new ExprDrivenStmtVisitor(new AlgebraicSimplifyVisitor(witness, view)),
    );
  },
};
