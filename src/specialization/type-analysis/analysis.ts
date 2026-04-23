import { ExprNS, StmtNS } from "../../ast-types";
import { TokenType } from "../../tokenizer";
import type { Narrowing } from "../framework/analysis";
import { isRoot, type Speculation } from "../framework/assumption-chain";
import { at } from "../framework/assumption-algebra";
import { MutableEnv } from "../framework/mutable-env";
import { paramTypeNarrowing } from "../framework/param-handles";
import type { BlockDfaSpec } from "../framework/dfa-factory";
import type { RawKind } from "../framework/raw-value";
import { isLocal, type SlotLookup } from "../framework/slot-table";
import { paramKeysFor, type NodeId, type ParamKey } from "../framework/key-spaces";
import { transferBlock } from "../framework/block-transfer";
import { makeBlockFixpointAnalysis, type BlockFixpointAnalysis } from "../framework/dfa-factory";
import {
  type TypeLattice,
  ALL_KINDS_MASK,
  boolValue,
  BOOL_BIT,
  BOOL_FALSE,
  BOOL_TRUE,
  BoolRef,
  BOTTOM,
  CLOSURE,
  CLOSURE_BIT,
  COMPLEX,
  FLOAT_BIT,
  FLOAT_NEG,
  FLOAT_POS,
  FLOAT_ZERO,
  floatValue,
  INT_BIT,
  INT_NEG,
  INT_POS,
  INT_ZERO,
  IntRef,
  join,
  leq,
  eq,
  meet,
  NULL,
  NULL_BIT,
  STR_BIT,
  STRING,
  TOP,
} from "./lattice";
import {
  transferBinaryOp,
  transferCompare,
  transferNot,
  transferUnaryNeg,
  truthiness,
} from "./transfer";

const BINARY_OP_MAP: ReadonlyMap<TokenType, string> = new Map([
  [TokenType.PLUS, "+"],
  [TokenType.MINUS, "-"],
  [TokenType.STAR, "*"],
  [TokenType.SLASH, "/"],
  [TokenType.DOUBLESLASH, "//"],
  [TokenType.PERCENT, "%"],
]);

const COMPARE_OP_MAP: ReadonlyMap<TokenType, string> = new Map([
  [TokenType.LESS, "<"],
  [TokenType.GREATER, ">"],
  [TokenType.LESSEQUAL, "<="],
  [TokenType.GREATEREQUAL, ">="],
  [TokenType.DOUBLEEQUAL, "=="],
  [TokenType.NOTEQUAL, "!="],
]);

/** Node-keyed type-narrowing fact-surface identity. Not used as a chain-
 *  extension namespace in production (no `observationSource`); retained as
 *  an identity handle for synthetic test chain extensions. */
export const typeNarrowing: Narrowing<NodeId, TypeLattice> = {
  eq,
  blockAnalysis: () => typeAnalysis,
  lift: liftType,
};

class TypeAnalysisVisitor implements ExprNS.Visitor<TypeLattice> {
  // Pooled: fields reassigned per `transferBlock` call via `reset()`.
  private slotTypes!: MutableEnv<TypeLattice>;
  private paramKeys!: readonly ParamKey[];
  private slotLookup!: SlotLookup;
  private recordExprFact!: (nodeId: NodeId, val: TypeLattice) => void;
  private context!: Speculation;
  private rootContext = true;

  reset(
    slotTypes: MutableEnv<TypeLattice>,
    paramKeys: readonly ParamKey[],
    slotLookup: SlotLookup,
    recordExprFact: (nodeId: NodeId, val: TypeLattice) => void,
    context: Speculation,
  ): this {
    this.slotTypes = slotTypes;
    this.paramKeys = paramKeys;
    this.slotLookup = slotLookup;
    this.recordExprFact = recordExprFact;
    this.context = context;
    this.rootContext = isRoot(context);
    return this;
  }

  /** Record a per-node type fact. Non-ROOT chains may carry a `typeNarrowing`
   *  binding (synthetic test extensions only); when present, meet it in. */
  private annotate(node: ExprNS.Expr, val: TypeLattice): TypeLattice {
    const assumption = this.rootContext
      ? undefined
      : at(this.context, typeNarrowing, node.id);
    const combined = assumption !== undefined ? meet(val, assumption) : val;
    this.recordExprFact(node.id, combined);
    return combined;
  }

  visitLiteralExpr(expr: ExprNS.Literal): TypeLattice {
    // `ExprNS.Literal` with typeof "number" is always a Python float — int
    // literals parse to `ExprNS.BigIntLiteral`.
    const value = expr.value;
    if (typeof value === "number") {
      return this.annotate(expr, Number.isNaN(value) ? floatValue() : signedFloat(value));
    }
    if (typeof value === "boolean") return this.annotate(expr, value ? BOOL_TRUE : BOOL_FALSE);
    if (typeof value === "string") return this.annotate(expr, STRING);
    return this.annotate(expr, TOP);
  }

  visitBigIntLiteralExpr(expr: ExprNS.BigIntLiteral): TypeLattice {
    return this.annotate(expr, signedInt(Number(expr.value)));
  }

  private paramAssumption(slot: number): TypeLattice | undefined {
    if (this.rootContext || slot < 0 || slot >= this.paramKeys.length) return undefined;
    return at(this.context, paramTypeNarrowing, this.paramKeys[slot]);
  }

  visitVariableExpr(expr: ExprNS.Variable): TypeLattice {
    const info = this.slotLookup(expr.name);
    if (!isLocal(info)) return this.annotate(expr, TOP);
    const slotInfo = this.slotTypes.get(info.slot) ?? TOP;
    const param = this.paramAssumption(info.slot);
    return this.annotate(expr, param !== undefined ? meet(slotInfo, param) : slotInfo);
  }

  visitBinaryExpr(expr: ExprNS.Binary): TypeLattice {
    const left = expr.left.accept(this);
    const right = expr.right.accept(this);

    // str+str → string (handled before numeric dispatch).
    if (
      expr.operator.type === TokenType.PLUS &&
      left.kinds === STR_BIT &&
      right.kinds === STR_BIT
    ) {
      return this.annotate(expr, STRING);
    }

    const opStr = BINARY_OP_MAP.get(expr.operator.type);
    if (opStr !== undefined) {
      return this.annotate(expr, transferBinaryOp(opStr, left, right));
    }

    return this.annotate(expr, TOP);
  }

  visitCompareExpr(expr: ExprNS.Compare): TypeLattice {
    const left = expr.left.accept(this);
    const right = expr.right.accept(this);

    const opStr = COMPARE_OP_MAP.get(expr.operator.type);
    if (opStr !== undefined) {
      return this.annotate(expr, transferCompare(opStr, left, right));
    }

    return this.annotate(expr, boolValue(BoolRef.Top));
  }

  // Python short-circuit: `a and b` → a if falsy else b; `a or b` → a if
  // truthy else b. Uses full-kind truthiness so it fires on non-bool kinds
  // (None, int-zero/nonzero, closure). Both operands are always visited so
  // downstream analyses receive sub-expression annotations.
  visitBoolOpExpr(expr: ExprNS.BoolOp): TypeLattice {
    const left = expr.left.accept(this);
    const right = expr.right.accept(this);
    const truth = truthiness(left);

    switch (expr.operator.type) {
      case TokenType.AND:
        if (truth === BoolRef.False) return this.annotate(expr, left);
        if (truth === BoolRef.True) return this.annotate(expr, right);
        return this.annotate(expr, join(left, right));
      case TokenType.OR:
        if (truth === BoolRef.True) return this.annotate(expr, left);
        if (truth === BoolRef.False) return this.annotate(expr, right);
        return this.annotate(expr, join(left, right));
      default:
        return this.annotate(expr, TOP);
    }
  }

  visitUnaryExpr(expr: ExprNS.Unary): TypeLattice {
    const operand = expr.right.accept(this);

    switch (expr.operator.type) {
      case TokenType.MINUS:
        return this.annotate(expr, transferUnaryNeg(operand));
      case TokenType.NOT:
        return this.annotate(expr, transferNot(operand));
      case TokenType.PLUS:
        return this.annotate(expr, operand);
      default:
        return this.annotate(expr, TOP);
    }
  }

  visitTernaryExpr(expr: ExprNS.Ternary): TypeLattice {
    expr.predicate.accept(this);
    const cons = expr.consequent.accept(this);
    const alt = expr.alternative.accept(this);
    return this.annotate(expr, join(cons, alt));
  }

  visitCallExpr(expr: ExprNS.Call): TypeLattice {
    expr.callee.accept(this);
    for (const arg of expr.args) {
      arg.accept(this);
    }
    return this.annotate(expr, TOP);
  }

  visitGroupingExpr(expr: ExprNS.Grouping): TypeLattice {
    const val = expr.expression.accept(this);
    return this.annotate(expr, val);
  }

  visitLambdaExpr(expr: ExprNS.Lambda): TypeLattice {
    return this.annotate(expr, CLOSURE);
  }

  visitMultiLambdaExpr(expr: ExprNS.MultiLambda): TypeLattice {
    return this.annotate(expr, CLOSURE);
  }

  visitNoneExpr(expr: ExprNS.None): TypeLattice {
    return this.annotate(expr, NULL);
  }

  visitListExpr(expr: ExprNS.List): TypeLattice {
    for (const el of expr.elements) {
      el.accept(this);
    }
    return this.annotate(expr, TOP);
  }

  visitSubscriptExpr(expr: ExprNS.Subscript): TypeLattice {
    expr.value.accept(this);
    expr.index.accept(this);
    return this.annotate(expr, TOP);
  }

  visitStarredExpr(expr: ExprNS.Starred): TypeLattice {
    expr.value.accept(this);
    return this.annotate(expr, TOP);
  }

  visitComplexExpr(expr: ExprNS.Complex): TypeLattice {
    return this.annotate(expr, COMPLEX);
  }
}

const POOLED_TYPE_VISITOR = new TypeAnalysisVisitor();

/** Forward may-analysis module. ROOT facts are context-free; non-ROOT
 *  contexts consult assumptions via `findAssumption`. */
const typeAnalysisModule: BlockDfaSpec<TypeLattice> = {
  mergeKind: "may",
  direction: "forward",
  bottom: BOTTOM,
  top: TOP,
  join,
  meet,
  leq,
  eq,
  makeExprVisitor(
    env: MutableEnv<TypeLattice>,
    unit,
    slotLookup: SlotLookup,
    recordExprFact: (nodeId: NodeId, val: TypeLattice) => void,
    context: Speculation,
  ): ExprNS.Visitor<TypeLattice> {
    const paramCount = unit.funcAst instanceof StmtNS.FunctionDef
      ? unit.funcAst.parameters.length
      : 0;
    return POOLED_TYPE_VISITOR.reset(
      env,
      paramKeysFor(unit.funcAst.id, paramCount),
      slotLookup,
      recordExprFact,
      context,
    );
  },
  /** Narrow env on branch edge. Handles `slot OP literal` / `literal OP slot`
   *  (six comparison ops) and `not c`. Other predicate shapes return `env`
   *  unchanged — sound no-op. */
  refineOnEdge(env, edge) {
    if (edge.kind === "unconditional") return env;
    const truth = edge.kind === "branch-true";
    const slotLookup = edge.from.unit.slotLookup;
    return applyPredicate(env, edge.condition, truth, slotLookup);
  },
};

/** Block-level fixpoint analysis for type narrowing. Owned here at the
 *  dimension's source so `typeNarrowing.blockAnalysis` has a stable binding. */
export const typeAnalysis: BlockFixpointAnalysis<TypeLattice> =
  makeBlockFixpointAnalysis<TypeLattice>({
    direction: typeAnalysisModule.direction,
    valueLattice: typeAnalysisModule,
    mergeKind: typeAnalysisModule.mergeKind,
    seedEnv: () => new MutableEnv<TypeLattice>(),
    transferBlock: (ctx, block, inEnv, unit) =>
      transferBlock(block, inEnv, typeAnalysisModule, unit, ctx.currentContext),
    refineOnEdge: (env, edge) => typeAnalysisModule.refineOnEdge(env, edge),
  });

// ---- Predicate narrowing helpers ----

function readNumericLiteral(expr: ExprNS.Expr): number | undefined {
  if (expr instanceof ExprNS.Literal && typeof expr.value === "number") {
    return expr.value;
  }
  if (expr instanceof ExprNS.BigIntLiteral) {
    return Number(expr.value);
  }
  return undefined;
}

function signOf(value: number): IntRef {
  if (Number.isNaN(value)) return IntRef.Top;
  if (value > 0) return IntRef.Pos;
  if (value < 0) return IntRef.Neg;
  return IntRef.Zero;
}

/** Refinement covering int, float and bool kinds with the given sign.
 *  Python bool ⊂ int, so `b > 0` must refine a bool slot — not collapse it.
 *  BoolRef is derived by truthiness: nonzero signs → True, zero sign → False. */
function numericRefinement(ref: IntRef): TypeLattice {
  const hasTruthy = (ref & (IntRef.Neg | IntRef.Pos)) !== 0;
  const hasFalsy = (ref & IntRef.Zero) !== 0;
  const boolRef = (((hasTruthy ? BoolRef.True : 0) |
    (hasFalsy ? BoolRef.False : 0)) as BoolRef);
  return {
    kinds: INT_BIT | FLOAT_BIT | BOOL_BIT,
    intRef: ref,
    floatRef: ref,
    boolRef,
  };
}

// Truthiness masks for `if x:` / `if not x:`. TRUTHY drops NULL (None is
// always falsy); FALSY drops CLOSURE (functions are always truthy). STR and
// COMPLEX stay in both since emptiness/zero-ness aren't tracked (sound).
const TRUTHY_MASK: TypeLattice = {
  kinds: ALL_KINDS_MASK & ~NULL_BIT,
  intRef: IntRef.NonZero,
  floatRef: IntRef.NonZero,
  boolRef: BoolRef.True,
};
const FALSY_MASK: TypeLattice = {
  kinds: ALL_KINDS_MASK & ~CLOSURE_BIT,
  intRef: IntRef.Zero,
  floatRef: IntRef.Zero,
  boolRef: BoolRef.False,
};

/** Sign refinement for `slot OP literal` (slot on left). Returns `undefined`
 *  when the sign lattice cannot refine further (e.g. `slot > -5` has no
 *  sign bound since any non-negative value qualifies). */
function leftSlotRefinement(op: string, c: number): IntRef | undefined {
  const sign = signOf(c);
  switch (op) {
    case ">":
      return sign === IntRef.Neg ? undefined : IntRef.Pos;
    case "<":
      return sign === IntRef.Pos ? undefined : IntRef.Neg;
    case ">=":
      if (sign === IntRef.Pos) return IntRef.Pos;
      if (sign === IntRef.Zero) return IntRef.NonNeg;
      return undefined;
    case "<=":
      if (sign === IntRef.Neg) return IntRef.Neg;
      if (sign === IntRef.Zero) return IntRef.NonPos;
      return undefined;
    case "==":
      return sign;
    case "!=":
      // Only refines at c=0: slot ≠ 0 → NonZero.
      return sign === IntRef.Zero ? IntRef.NonZero : undefined;
    default:
      return undefined;
  }
}

/** `c OP slot` ≡ `slot OP_SWAPPED c`. */
function swapOp(op: string): string {
  switch (op) {
    case "<": return ">";
    case ">": return "<";
    case "<=": return ">=";
    case ">=": return "<=";
    default: return op; // == and != are symmetric
  }
}

function negateOp(op: string): string {
  switch (op) {
    case ">": return "<=";
    case "<": return ">=";
    case ">=": return "<";
    case "<=": return ">";
    case "==": return "!=";
    case "!=": return "==";
    default: return op;
  }
}

/** Apply a predicate to the env. Returns `env` unchanged when no refinement
 *  is possible — callers use identity to skip the snapshot. */
function applyPredicate(
  env: MutableEnv<TypeLattice>,
  cond: ExprNS.Expr,
  truth: boolean,
  slotLookup: SlotLookup,
): MutableEnv<TypeLattice> {
  if (cond instanceof ExprNS.Unary && cond.operator.type === TokenType.NOT) {
    return applyPredicate(env, cond.right, !truth, slotLookup);
  }
  if (cond instanceof ExprNS.Grouping) {
    return applyPredicate(env, cond.expression, truth, slotLookup);
  }

  // Bare-variable predicate `if x:` — narrow x by full-kind truthiness mask.
  if (cond instanceof ExprNS.Variable) {
    const info = slotLookup(cond.name);
    if (!isLocal(info)) return env;
    const existing = env.get(info.slot) ?? TOP;
    const refined = meet(existing, truth ? TRUTHY_MASK : FALSY_MASK);
    if (refined === existing) return env;
    const out = env.snapshot();
    out.set(info.slot, refined);
    return out;
  }

  if (!(cond instanceof ExprNS.Compare)) return env;
  const opStr = COMPARE_OP_MAP.get(cond.operator.type);
  if (opStr === undefined) return env;

  // Push negation into the operator so `leftSlotRefinement` sees the
  // predicate as directly asserted. Then normalize to `slot OP literal` form.
  const effectiveOp = truth ? opStr : negateOp(opStr);
  let slotVar: ExprNS.Variable;
  let litValue: number | undefined;
  let normalizedOp: string;
  const leftLit = readNumericLiteral(cond.left);
  const rightLit = readNumericLiteral(cond.right);
  if (cond.left instanceof ExprNS.Variable && rightLit !== undefined) {
    slotVar = cond.left;
    litValue = rightLit;
    normalizedOp = effectiveOp;
  } else if (cond.right instanceof ExprNS.Variable && leftLit !== undefined) {
    slotVar = cond.right;
    litValue = leftLit;
    normalizedOp = swapOp(effectiveOp);
  } else {
    return env;
  }

  const info = slotLookup(slotVar.name);
  if (!isLocal(info)) return env;

  const ref = leftSlotRefinement(normalizedOp, litValue);
  if (ref === undefined) return env;

  const existing = env.get(info.slot) ?? TOP;
  const refined = meet(existing, numericRefinement(ref));
  if (refined === existing) return env;

  const out = env.snapshot();
  out.set(info.slot, refined);
  return out;
}

function signedInt(n: number): TypeLattice {
  if (n > 0) return INT_POS;
  if (n < 0) return INT_NEG;
  return INT_ZERO;
}

function signedFloat(n: number): TypeLattice {
  if (n > 0) return FLOAT_POS;
  if (n < 0) return FLOAT_NEG;
  return FLOAT_ZERO;
}

export function liftType(rawKind: RawKind): TypeLattice | undefined {
  switch (rawKind.kind) {
    case "number": {
      const v = rawKind.value;
      if (Number.isInteger(v) && Number.isFinite(v)) return signedInt(v);
      if (Number.isNaN(v)) return floatValue();
      return signedFloat(v);
    }
    case "bool":
      return rawKind.value ? BOOL_TRUE : BOOL_FALSE;
    case "string":
      return STRING;
    case "none":
      return NULL;
    case "closure":
      return CLOSURE;
    case "complex":
      return COMPLEX;
    case "unknown":
      return undefined;
  }
}
