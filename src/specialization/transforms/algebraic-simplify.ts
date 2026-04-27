import { ExprNS, StmtNS } from "../../ast-types";
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
import type { AssumptionChain } from "../assumption/chain";
import { visibleBody } from "../speculation/assumption-bodies";
import type { Function } from "../program/function/function";
import type { FunctionLocator } from "../program/function/manager";
import { DescendingExprVisitor, IdReplacer, rewriteStmtRhs } from "./expr-visitor";
import { groupPlansByWitness, runPerWitness } from "./witness-sweep";

type Plan = { witness: AssumptionChain; replacement: ExprNS.Expr };
type Witnessed<V> = { value: V; witness: AssumptionChain };
type Ctx = { readonly chain: AssumptionChain; readonly view: FunctionLocator };

/** A rewrite gate. `undefined` = fail. `null` = pass without contributing
 *  a witness (structural). An `AssumptionChain` = pass with that witness. */
type Predicate<F> = (facts: F) => AssumptionChain | null | undefined;

const readType = (ctx: Ctx, node: ExprNS.Expr): Witnessed<TypeLattice> | undefined =>
  typeAnalysis.perExpr(ctx.view).readMinimal(ctx.chain, node.id, () => true);

const readConst = (ctx: Ctx, node: ExprNS.Expr): Witnessed<ConstLattice> | undefined =>
  constAnalysis.perExpr(ctx.view).readMinimal(ctx.chain, node.id, () => true);

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

interface BinaryFacts {
  readonly expr: ExprNS.Binary;
  readonly leftType: Witnessed<TypeLattice> | undefined;
  readonly rightType: Witnessed<TypeLattice> | undefined;
  readonly leftConst: Witnessed<ConstLattice> | undefined;
  readonly rightConst: Witnessed<ConstLattice> | undefined;
}

const pureIntL: Predicate<BinaryFacts> = f =>
  f.leftType?.value.kinds === INT_BIT ? f.leftType.witness : undefined;
const pureIntR: Predicate<BinaryFacts> = f =>
  f.rightType?.value.kinds === INT_BIT ? f.rightType.witness : undefined;
const zeroL: Predicate<BinaryFacts> = f => intZeroWitness(f.leftType, f.leftConst);
const zeroR: Predicate<BinaryFacts> = f => intZeroWitness(f.rightType, f.rightConst);
const oneL: Predicate<BinaryFacts> = f =>
  f.leftConst?.value.tag === "const" && f.leftConst.value.value === 1
    ? f.leftConst.witness
    : undefined;
const oneR: Predicate<BinaryFacts> = f =>
  f.rightConst?.value.tag === "const" && f.rightConst.value.value === 1
    ? f.rightConst.witness
    : undefined;
const safeDropL: Predicate<BinaryFacts> = f => (isSafeToDrop(f.expr.left) ? null : undefined);
const safeDropR: Predicate<BinaryFacts> = f => (isSafeToDrop(f.expr.right) ? null : undefined);

interface BoolOpFacts {
  readonly expr: ExprNS.BoolOp;
  readonly leftType: Witnessed<TypeLattice> | undefined;
}

const truthyL = (expected: BoolRef.True | BoolRef.False): Predicate<BoolOpFacts> => f =>
  f.leftType !== undefined && truthiness(f.leftType.value) === expected
    ? f.leftType.witness
    : undefined;

/** Run every predicate; on full match, return the deepest contributed witness
 *  (or `fallback` if none were contributed). On any failure, return `undefined`. */
function joinPredicates<F>(
  predicates: readonly Predicate<F>[],
  facts: F,
  fallback: AssumptionChain,
): AssumptionChain | undefined {
  let deepest: AssumptionChain | undefined;
  for (const p of predicates) {
    const r = p(facts);
    if (r === undefined) return undefined;
    if (r !== null && (deepest === undefined || r.depth > deepest.depth)) deepest = r;
  }
  return deepest ?? fallback;
}

interface Rule<E, F> {
  readonly op: TokenType;
  readonly match: readonly Predicate<F>[];
  readonly pick: (expr: E) => ExprNS.Expr;
}

const mkZero = (e: ExprNS.Binary): ExprNS.Expr => new ExprNS.Literal(e.startToken, e.endToken, 0);

const BINARY_RULES: readonly Rule<ExprNS.Binary, BinaryFacts>[] = [
  { op: TokenType.PLUS,        match: [pureIntL, zeroR],                  pick: e => e.left },
  { op: TokenType.PLUS,        match: [zeroL,    pureIntR],               pick: e => e.right },
  { op: TokenType.MINUS,       match: [pureIntL, zeroR],                  pick: e => e.left },
  { op: TokenType.STAR,        match: [pureIntL, oneR],                   pick: e => e.left },
  { op: TokenType.STAR,        match: [oneL,     pureIntR],               pick: e => e.right },
  { op: TokenType.STAR,        match: [pureIntL, zeroR, safeDropL],       pick: mkZero },
  { op: TokenType.STAR,        match: [zeroL,    pureIntR, safeDropR],    pick: mkZero },
  { op: TokenType.DOUBLESLASH, match: [pureIntL, oneR],                   pick: e => e.left },
];

const BOOLOP_RULES: readonly Rule<ExprNS.BoolOp, BoolOpFacts>[] = [
  { op: TokenType.AND, match: [truthyL(BoolRef.False)], pick: e => e.left },
  { op: TokenType.AND, match: [truthyL(BoolRef.True)],  pick: e => e.right },
  { op: TokenType.OR,  match: [truthyL(BoolRef.False)], pick: e => e.right },
  { op: TokenType.OR,  match: [truthyL(BoolRef.True)],  pick: e => e.left },
];

function firstMatch<E extends { operator: { type: TokenType } }, F>(
  rules: readonly Rule<E, F>[],
  expr: E,
  facts: F,
  fallback: AssumptionChain,
): Plan | undefined {
  for (const r of rules) {
    if (r.op !== expr.operator.type) continue;
    const witness = joinPredicates(r.match, facts, fallback);
    if (witness !== undefined) return { witness, replacement: r.pick(expr) };
  }
  return undefined;
}

function planUnary(expr: ExprNS.Unary, ctx: Ctx): Plan | undefined {
  const inner = unwrapGrouping(expr.right);
  if (
    expr.operator.type === TokenType.MINUS &&
    inner instanceof ExprNS.Unary &&
    inner.operator.type === TokenType.MINUS
  ) {
    return { witness: ctx.chain, replacement: inner.right };
  }
  if (
    expr.operator.type === TokenType.NOT &&
    inner instanceof ExprNS.Unary &&
    inner.operator.type === TokenType.NOT
  ) {
    const body = inner.right;
    const t = readType(ctx, body);
    if (t?.value.kinds === BOOL_BIT) return { witness: t.witness, replacement: body };
  }
  return undefined;
}

class AlgebraicMatcher extends DescendingExprVisitor {
  constructor(
    private readonly ctx: Ctx,
    private readonly out: Map<number, Plan>,
  ) {
    super();
  }

  visitBinaryExpr(expr: ExprNS.Binary): ExprNS.Expr {
    super.visitBinaryExpr(expr);
    const facts: BinaryFacts = {
      expr,
      leftType: readType(this.ctx, expr.left),
      rightType: readType(this.ctx, expr.right),
      leftConst: readConst(this.ctx, expr.left),
      rightConst: readConst(this.ctx, expr.right),
    };
    const plan = firstMatch(BINARY_RULES, expr, facts, this.ctx.chain);
    if (plan !== undefined) this.out.set(expr.id, plan);
    return expr;
  }
  visitBoolOpExpr(expr: ExprNS.BoolOp): ExprNS.Expr {
    super.visitBoolOpExpr(expr);
    const facts: BoolOpFacts = { expr, leftType: readType(this.ctx, expr.left) };
    const plan = firstMatch(BOOLOP_RULES, expr, facts, this.ctx.chain);
    if (plan !== undefined) this.out.set(expr.id, plan);
    return expr;
  }
  visitUnaryExpr(expr: ExprNS.Unary): ExprNS.Expr {
    super.visitUnaryExpr(expr);
    const plan = planUnary(expr, this.ctx);
    if (plan !== undefined) this.out.set(expr.id, plan);
    return expr;
  }
}

export const algebraicSimplifyRule: TransformRule = {
  bind(wl) {
    wl.onTransformFactDirty(algebraicSimplifyRule, typeAnalysis.facts, (_, b) => [b.unit]);
  },
  sweep(unit: Function, chain: AssumptionChain, view: FunctionLocator) {
    const plans = new Map<number, Plan>();
    rewriteStmtRhs(visibleBody(unit, chain) as StmtNS.Stmt[], new AlgebraicMatcher({ chain, view }, plans));

    return runPerWitness(unit, groupPlansByWitness(plans), (body, replacements) => {
      const replacer = new IdReplacer(replacements);
      rewriteStmtRhs(body, replacer);
      return replacer.changed;
    });
  },
};
