import { ExprNS, StmtNS } from "../../../ast-types";
import { TokenType } from "../../../tokenizer";
import { type AssumptionChain, at, isRoot } from "../../assumption";
import type { Narrowing, NodeId } from "../../framework/analysis";
import type { FunctionId } from "../../program/function";
import type { ParamKey } from "../../narrowing-policy/param-key";
import { MutableEnv } from "../../analysis/mutable-env";
import { isLocal, type SlotLookup } from "../../program/slot-table";
import { blockFixpointFromSpec } from "../../analysis/stmt-transfer";
import { paramTypeNarrowing } from "../../narrowing-policy/param-handles";
import type { RawKind } from "../../observation/raw-value";
import type { BlockDfaSpec, BlockFixpointAnalysis } from "../dfa-factory";
import {
    ALL_KINDS_MASK,
    BOOL_BIT,
    BOOL_FALSE,
    BOOL_TRUE,
    BoolRef,
    boolValue,
    CLOSURE,
    CLOSURE_BIT,
    COMPLEX,
    eq,
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
    meet,
    NULL,
    NULL_BIT,
    STR_BIT,
    STRING,
    TOP,
    type TypeLattice,
    typeLattice,
} from "./lattice";
import {
    transferBinaryOp,
    transferCompare,
    transferNot,
    transferUnaryNeg,
    truthiness,
} from "./transfer";

/** Interned `${fid}:${i}` ParamKeys, grown on demand. */
const PARAM_KEYS: Map<FunctionId, ParamKey[]> = new Map();
function paramKeysFor(fid: FunctionId, count: number): readonly ParamKey[] {
  let arr = PARAM_KEYS.get(fid);
  if (arr === undefined) { arr = []; PARAM_KEYS.set(fid, arr); }
  while (arr.length < count) arr.push(`${fid}:${arr.length}` as ParamKey);
  return arr;
}

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

/** Node-keyed type-narrowing. A `(typeNarrowing, nodeId, lattice)` binding in
 *  a non-ROOT context is met into the per-node fact via `annotate` — no
 *  separate store. Currently used by tests only; production param/return
 *  bindings live in `narrowing-policy/` and `type-requirement/`. */
export const typeNarrowing: Narrowing<NodeId, TypeLattice> = {
  eq,
  blockAnalysis: () => typeAnalysis,
};

class TypeAnalysisVisitor implements ExprNS.Visitor<TypeLattice> {
  // Pooled: fields reassigned per `transferBlock` call via `reset()`.
  private slotTypes!: MutableEnv<TypeLattice>;
  private paramKeys!: readonly ParamKey[];
  private slotLookup!: SlotLookup;
  private recordExprFact!: (nodeId: NodeId, val: TypeLattice) => void;
  private context!: AssumptionChain;
  private rootContext = true;

  reset(
    slotTypes: MutableEnv<TypeLattice>,
    paramKeys: readonly ParamKey[],
    slotLookup: SlotLookup,
    recordExprFact: (nodeId: NodeId, val: TypeLattice) => void,
    context: AssumptionChain,
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
    let result: TypeLattice;
    if (typeof value === "number") {
      result = Number.isNaN(value) ? floatValue() : signedFloat(value);
    } else if (typeof value === "boolean") {
      result = value ? BOOL_TRUE : BOOL_FALSE;
    } else if (typeof value === "string") {
      result = STRING;
    } else {
      result = TOP;
    }
    return this.annotate(expr, result);
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
    const opType = expr.operator.type;

    let result: TypeLattice;
    if (opType === TokenType.AND) {
      if (truth === BoolRef.False) result = left;
      else if (truth === BoolRef.True) result = right;
      else result = join(left, right);
    } else if (opType === TokenType.OR) {
      if (truth === BoolRef.True) result = left;
      else if (truth === BoolRef.False) result = right;
      else result = join(left, right);
    } else {
      result = TOP;
    }
    return this.annotate(expr, result);
  }

  visitUnaryExpr(expr: ExprNS.Unary): TypeLattice {
    const operand = expr.right.accept(this);

    let result: TypeLattice;
    switch (expr.operator.type) {
      case TokenType.MINUS: result = transferUnaryNeg(operand); break;
      case TokenType.NOT:   result = transferNot(operand); break;
      case TokenType.PLUS:  result = operand; break;
      default:              result = TOP;
    }
    return this.annotate(expr, result);
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

const typeAnalysisModule: BlockDfaSpec<TypeLattice> = {
  ...typeLattice,
  mergeKind: "may",
  direction: "forward",
  makeExprVisitor(
    env: MutableEnv<TypeLattice>,
    unit,
    slotLookup: SlotLookup,
    recordExprFact: (nodeId: NodeId, val: TypeLattice) => void,
    context: AssumptionChain,
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
  refineOnEdge(env, edge, unit) {
    if (edge.kind === "unconditional") return env;
    const truth = edge.kind === "branch-true";
    return applyPredicate(env, edge.condition, truth, unit.slotLookup);
  },
};

export const typeAnalysis: BlockFixpointAnalysis<TypeLattice> =
  blockFixpointFromSpec(typeAnalysisModule);

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
  let boolRef: BoolRef = BoolRef.Bottom;
  if (hasTruthy) boolRef = (boolRef | BoolRef.True) as BoolRef;
  if (hasFalsy) boolRef = (boolRef | BoolRef.False) as BoolRef;
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
    return refineSlot(env, cond, truth ? TRUTHY_MASK : FALSY_MASK, slotLookup);
  }

  if (!(cond instanceof ExprNS.Compare)) return env;
  const opStr = COMPARE_OP_MAP.get(cond.operator.type);
  if (opStr === undefined) return env;

  // Push negation into the operator so `leftSlotRefinement` sees the
  // predicate as directly asserted. Then normalize to `slot OP literal` form.
  const effectiveOp = truth ? opStr : negateOp(opStr);
  let slotVar: ExprNS.Variable;
  let litValue: number;
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

  const ref = leftSlotRefinement(normalizedOp, litValue);
  if (ref === undefined) return env;

  return refineSlot(env, slotVar, numericRefinement(ref), slotLookup);
}

/** Meet-refine a slot's env entry by `mask`; snapshot only when the value
 *  changes. Returns `env` unchanged when the slot is non-local or the meet
 *  is a no-op. */
function refineSlot(
  env: MutableEnv<TypeLattice>,
  slotVar: ExprNS.Variable,
  mask: TypeLattice,
  slotLookup: SlotLookup,
): MutableEnv<TypeLattice> {
  const info = slotLookup(slotVar.name);
  if (!isLocal(info)) return env;
  const existing = env.get(info.slot) ?? TOP;
  const refined = meet(existing, mask);
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
