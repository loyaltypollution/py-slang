import { ExprNS, StmtNS } from "../../ast-types";
import { TokenType } from "../../tokens";
import type { AssumptionHandle } from "../framework/analysis";
import { findAssumption, ROOT_CONTEXT, type Context } from "../framework/context";
import type { MutableEnv } from "../framework/mutable-env";
import { paramTypeHandle } from "../entry-guards";
import type { BlockDfaSpec } from "../framework/interfaces";
import type { RawKind } from "../framework/raw-value";
import { isLocal, type SlotLookup } from "../framework/slot-table";
import { paramKey, type FunctionId, type NodeId } from "../framework/key-spaces";
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

/** Runtime observations no longer strengthen ROOT facts. Baseline type facts
 *  are derived from program semantics only; runtime/profile input participates
 *  through non-ROOT Context assumptions instead. */

/** Assumption-binding identity used by Context. Callers build a Context by
 *  extending a parent with `(typeExprHandle, nodeId, narrowedValue)`; the
 *  `TypeAnalysisVisitor` consults `findAssumption` at each node visit and
 *  meets the computed static fact with the bound value. The handle itself
 *  is never scheduled — its `transfer` is a no-op and no analysis store
 *  carries cells under this Analysis — it exists purely as a per-node
 *  assumption namespace keyed into the Context chain.
 *
 *  The pairing with `typeAnalysis` and `typeValueEqual` used by
 *  `Worklist.widenGuard`'s lineage walk is assembled as a `Narrowing` in
 *  `dfa-analyses.ts` — kept out of this file to avoid a top-level circular
 *  import. */
export const typeExprHandle: AssumptionHandle<NodeId, TypeLattice> = {
  id: Symbol("typeExprHandle"),
  debugName: "typeExprHandle",
  keySpace: "nodeId",
  eq,
};

class TypeAnalysisVisitor implements ExprNS.Visitor<TypeLattice> {
  constructor(
    private readonly slotTypes: MutableEnv<TypeLattice>,
    private readonly functionId: FunctionId,
    private readonly paramCount: number,
    private readonly slotLookup: SlotLookup,
    private readonly recordExprFact: (nodeId: NodeId, val: TypeLattice) => void,
    private readonly context: Context,
  ) {}

  /** ROOT facts are purely semantic. Non-ROOT contexts may narrow them via
   *  assumptions carried in the Context chain. */
  private annotate(node: ExprNS.Expr, val: TypeLattice): TypeLattice {
    const assumption = this.context === ROOT_CONTEXT
      ? undefined
      : findAssumption(this.context, typeExprHandle, node.id);
    const combined = assumption !== undefined ? meet(val, assumption) : val;
    this.recordExprFact(node.id, combined);
    return combined;
  }

  visitLiteralExpr(expr: ExprNS.Literal): TypeLattice {
    const value = expr.value;
    if (typeof value === "number") {
      if (Number.isInteger(value) && Number.isFinite(value)) {
        const info = value > 0 ? INT_POS : value < 0 ? INT_NEG : INT_ZERO;
        return this.annotate(expr, info);
      }
      if (Number.isNaN(value)) return this.annotate(expr, floatValue());
      const info = value > 0 ? FLOAT_POS : value < 0 ? FLOAT_NEG : FLOAT_ZERO;
      return this.annotate(expr, info);
    } else if (typeof value === "boolean") {
      return this.annotate(expr, value ? BOOL_TRUE : BOOL_FALSE);
    } else if (typeof value === "string") {
      return this.annotate(expr, STRING);
    }
    return this.annotate(expr, TOP);
  }

  visitBigIntLiteralExpr(expr: ExprNS.BigIntLiteral): TypeLattice {
    const n = Number(expr.value);
    const info = n > 0 ? INT_POS : n < 0 ? INT_NEG : INT_ZERO;
    return this.annotate(expr, info);
  }

  private paramAssumption(slot: number): TypeLattice | undefined {
    if (this.context === ROOT_CONTEXT || slot < 0 || slot >= this.paramCount) return undefined;
    return findAssumption(this.context, paramTypeHandle, paramKey(this.functionId, slot));
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

  // Narrow `and`/`or` under Python short-circuit semantics:
  //   `a and b` → a if a is falsy else b
  //   `a or  b` → a if a is truthy else b
  // We compute truthiness of `left` over the full kind lattice (via
  // `truthiness`), so this fires whenever the lhs's truth value is known —
  // including non-bool kinds like None, int-zero, int-nonzero, closure.
  // When truthiness is Top we join both arms; when unresolved (Bottom) we
  // return the result of the short-circuit path the caller would take
  // lexically (the right arm), widened by the left.
  //
  // Both operands are always visited so downstream analyses receive
  // sub-expression annotations.
  visitBoolOpExpr(expr: ExprNS.BoolOp): TypeLattice {
    const left = expr.left.accept(this);
    const right = expr.right.accept(this);
    const truth = truthiness(left);

    if (expr.operator.type === TokenType.AND) {
      if (truth === BoolRef.False) return this.annotate(expr, left);
      if (truth === BoolRef.True) return this.annotate(expr, right);
      return this.annotate(expr, join(left, right));
    } else if (expr.operator.type === TokenType.OR) {
      if (truth === BoolRef.True) return this.annotate(expr, left);
      if (truth === BoolRef.False) return this.annotate(expr, right);
      return this.annotate(expr, join(left, right));
    }

    return this.annotate(expr, TOP);
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

/** Build a type-analysis module. ROOT facts are context-free semantic facts;
 *  non-ROOT contexts consult assumptions via `findAssumption`. */
export function makeTypeAnalysisModule(): BlockDfaSpec<TypeLattice> {
  return {
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
    context: Context,
  ): ExprNS.Visitor<TypeLattice> {
    return new TypeAnalysisVisitor(
      env,
      unit.funcAst.id,
      unit.funcAst instanceof StmtNS.FunctionDef ? unit.funcAst.parameters.length : 0,
      slotLookup,
      recordExprFact,
      context,
    );
  },
  /**
   * Narrow the env when crossing a branch edge. Handles `slot OP literal`
   * (and `literal OP slot`) for the six comparison operators and `not c`.
   * Any other predicate shape returns `env` unchanged — sound because a
   * predicate we can't read gives no new information.
   *
   * Only refines when the literal's numeric value is non-zero-signed enough
   * to produce a proper sub-lattice value; `slot > -5` stays as-is because
   * the sign lattice has no finer grain than {Neg, Zero, Pos, ...}.
   */
  refineOnEdge(env, edge) {
    if (edge.kind === "unconditional") return env;
    const truth = edge.kind === "branch-true";
    const slotLookup = edge.from.unit.slotLookup;
    return applyPredicate(env, edge.condition, truth, slotLookup);
  },
  };
}

// Forward may-analysis: env join = union; specialize only when numeric on all paths.
export const typeAnalysisModule: BlockDfaSpec<TypeLattice> = makeTypeAnalysisModule();

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
 *  Python bool ⊂ int, so a predicate like `b > 0` must be allowed to refine
 *  a bool slot — not collapse it to BOTTOM. We derive a matching BoolRef:
 *  the True bit is set iff the sign admits Pos (True == 1); the False bit
 *  iff the sign admits Zero (False == 0). Meeting with a pure-kind env slot
 *  keeps that kind; disjoint non-numeric slots (e.g. STRING) still collapse
 *  to BOTTOM, which is sound — the branch is unreachable. */
function numericRefinement(ref: IntRef): TypeLattice {
  // IntRef bits: Neg=1, Zero=2, Pos=4. BoolRef bits: True=1, False=2.
  // Python truthiness: nonzero int → True, zero → False. Both Neg and Pos
  // contribute to True; only Zero contributes to False.
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

// Truthiness masks for bare-variable predicates (`if x:` / `if not x:`).
// TRUTHY drops NULL (None is always falsy); FALSY drops CLOSURE (functions
// are always truthy). STR and COMPLEX stay in both — we don't track
// emptiness / zero-ness, so meet leaves them unchanged (sound no-op).
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

/** Sign refinement for `slot OP literal` where slot is on the left. `op`
 *  is one of the six comparison operators; `c` is the literal's numeric
 *  value. Returns `undefined` when the sign lattice cannot refine further
 *  (e.g. `slot > -5` admits any value ≥ -4, which has no sign bound). */
function leftSlotRefinement(op: string, c: number): IntRef | undefined {
  const sign = signOf(c);
  switch (op) {
    case ">":
      // slot > c. If c ≥ 0 → slot > 0 → Pos. If c < 0 → could be any.
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
      // slot == c → slot has c's sign.
      return sign;
    case "!=":
      // slot != c. Only refines when c is zero: slot ≠ 0 → NonZero.
      return sign === IntRef.Zero ? IntRef.NonZero : undefined;
    default:
      return undefined;
  }
}

/** Swap left/right semantics: `c OP slot` ≡ `slot OP_SWAPPED c`. */
function swapOp(op: string): string {
  switch (op) {
    case "<":
      return ">";
    case ">":
      return "<";
    case "<=":
      return ">=";
    case ">=":
      return "<=";
    default:
      return op; // == and != are symmetric
  }
}

function negateOp(op: string): string {
  switch (op) {
    case ">":
      return "<=";
    case "<":
      return ">=";
    case ">=":
      return "<";
    case "<=":
      return ">";
    case "==":
      return "!=";
    case "!=":
      return "==";
    default:
      return op;
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
  // Peel `not`: the inner predicate flips truth.
  if (cond instanceof ExprNS.Unary && cond.operator.type === TokenType.NOT) {
    return applyPredicate(env, cond.right, !truth, slotLookup);
  }
  if (cond instanceof ExprNS.Grouping) {
    return applyPredicate(env, cond.expression, truth, slotLookup);
  }

  // Bare-variable predicate: `if x:` narrows x to truthy values on the true
  // edge, falsy on the false edge. Uses the full-kind truthiness mask so it
  // fires on int/float/bool/None/closure slots — even where the sign lattice
  // has nothing to say.
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

  // Apply negation via op transformation so `leftSlotRefinement` sees the
  // operator as if the predicate were directly asserted.
  const effectiveOp = truth ? opStr : negateOp(opStr);

  // Find the (slot, literal) pair, whichever side each lives on.
  let slotSide: "left" | "right";
  let slotVar: ExprNS.Variable;
  let litValue: number | undefined;
  if (cond.left instanceof ExprNS.Variable && (litValue = readNumericLiteral(cond.right)) !== undefined) {
    slotSide = "left";
    slotVar = cond.left;
  } else if (cond.right instanceof ExprNS.Variable && (litValue = readNumericLiteral(cond.left)) !== undefined) {
    slotSide = "right";
    slotVar = cond.right;
  } else {
    return env;
  }

  const info = slotLookup(slotVar.name);
  if (!isLocal(info)) return env;

  const normalizedOp = slotSide === "left" ? effectiveOp : swapOp(effectiveOp);
  const ref = leftSlotRefinement(normalizedOp, litValue);
  if (ref === undefined) return env;

  const existing = env.get(info.slot) ?? TOP;
  const refined = meet(existing, numericRefinement(ref));
  if (refined === existing) return env;

  const out = env.snapshot();
  out.set(info.slot, refined);
  return out;
}

export function liftType(rawKind: RawKind): TypeLattice | undefined {
  switch (rawKind.kind) {
    case "number": {
      const v = rawKind.value;
      if (Number.isInteger(v) && Number.isFinite(v)) {
        return v > 0 ? INT_POS : v < 0 ? INT_NEG : INT_ZERO;
      }
      if (Number.isNaN(v)) return floatValue();
      return v > 0 ? FLOAT_POS : v < 0 ? FLOAT_NEG : FLOAT_ZERO;
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
