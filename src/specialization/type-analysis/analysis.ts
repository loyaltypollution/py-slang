import { ExprNS } from "../../ast-types";
import { TokenType } from "../../tokens";
import { type HintStore, type OptimizationHint } from "../framework/hint";
import type { AnalysisPass } from "../framework/interfaces";
import type { SlotLookup } from "../framework/slot-table";
import {
  type TypeLattice,
  BOOL_BIT,
  boolean as booleanValue,
  BoolRef,
  BOTTOM,
  closureValue,
  complexValue,
  falseValue,
  floatValue,
  join,
  leq,
  meet,
  negativeFloat,
  negativeInteger,
  nullValue,
  positiveFloat,
  positiveInteger,
  STR_BIT,
  stringValue,
  TOP,
  trueValue,
  zeroFloat,
  zeroInteger,
} from "./lattice";
import { transferBinaryOp, transferCompare, transferNot, transferUnaryNeg } from "./transfer";

/**
 * Maps Python binary operator token types to the string expected by transfer functions.
 */
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

export class TypeAnalysisVisitor implements ExprNS.Visitor<TypeLattice> {
  constructor(
    private readonly hints: HintStore,
    private readonly slotTypes: { get(slot: number): TypeLattice | undefined },
    private readonly slotLookup: SlotLookup,
  ) {}

  private annotate(node: ExprNS.Expr, val: TypeLattice): TypeLattice {
    this.hints.updateField(node.id, "type", val);
    return val;
  }

  visitLiteralExpr(expr: ExprNS.Literal): TypeLattice {
    const value = expr.value;
    if (typeof value === "number") {
      if (Number.isInteger(value) && Number.isFinite(value)) {
        const info = value > 0 ? positiveInteger() : value < 0 ? negativeInteger() : zeroInteger();
        return this.annotate(expr, info);
      }
      if (Number.isNaN(value)) return this.annotate(expr, floatValue());
      const info = value > 0 ? positiveFloat() : value < 0 ? negativeFloat() : zeroFloat();
      return this.annotate(expr, info);
    } else if (typeof value === "boolean") {
      return this.annotate(expr, value ? trueValue() : falseValue());
    } else if (typeof value === "string") {
      return this.annotate(expr, stringValue());
    }
    return this.annotate(expr, TOP);
  }

  visitBigIntLiteralExpr(expr: ExprNS.BigIntLiteral): TypeLattice {
    const n = Number(expr.value);
    const info = n > 0 ? positiveInteger() : n < 0 ? negativeInteger() : zeroInteger();
    return this.annotate(expr, info);
  }

  visitVariableExpr(expr: ExprNS.Variable): TypeLattice {
    const info = this.slotLookup(expr.name);
    if (info.isPrimitive) return this.annotate(expr, TOP);
    if (info.envLevel === 0) {
      const slotInfo = this.slotTypes.get(info.slot) ?? TOP;
      return this.annotate(expr, slotInfo);
    }
    return this.annotate(expr, TOP);
  }

  visitBinaryExpr(expr: ExprNS.Binary): TypeLattice {
    const left = expr.left.accept(this);
    const right = expr.right.accept(this);

    // String concatenation: handled before numeric dispatch so str+str → string, not TOP.
    if (
      expr.operator.type === TokenType.PLUS &&
      left.kinds === STR_BIT &&
      right.kinds === STR_BIT
    ) {
      return this.annotate(expr, stringValue());
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

    return this.annotate(expr, booleanValue(BoolRef.Top));
  }

  visitBoolOpExpr(expr: ExprNS.BoolOp): TypeLattice {
    const left = expr.left.accept(this);
    const right = expr.right.accept(this);

    const leftIsBool = left.kinds === BOOL_BIT;

    if (expr.operator.type === TokenType.AND) {
      if (leftIsBool && left.boolRef === BoolRef.False) return this.annotate(expr, falseValue());
      if (leftIsBool && left.boolRef === BoolRef.True) return this.annotate(expr, right);
      return this.annotate(expr, booleanValue(BoolRef.Top));
    } else if (expr.operator.type === TokenType.OR) {
      if (leftIsBool && left.boolRef === BoolRef.True) return this.annotate(expr, trueValue());
      if (leftIsBool && left.boolRef === BoolRef.False) return this.annotate(expr, right);
      return this.annotate(expr, booleanValue(BoolRef.Top));
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
    expr.consequent.accept(this);
    expr.alternative.accept(this);
    return this.annotate(expr, TOP);
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
    return this.annotate(expr, closureValue());
  }

  visitMultiLambdaExpr(expr: ExprNS.MultiLambda): TypeLattice {
    return this.annotate(expr, closureValue());
  }

  visitNoneExpr(expr: ExprNS.None): TypeLattice {
    return this.annotate(expr, nullValue());
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
    return this.annotate(expr, complexValue());
  }
}

/**
 * Type analysis AnalysisPass: wraps TypeAnalysisVisitor transfer functions
 * in the AnalysisPass interface. Lattice operations delegate to lattice.ts.
 *
 * This is a forward May analysis: merge = join (least upper bound).
 * At join points (if/else, loop headers) the env takes the union of possible types,
 * so we specialize only when the type is known to be numeric on ALL incoming paths.
 */
export class TypeAnalysisPass implements AnalysisPass<TypeLattice> {
  readonly name = "type";
  latticeEquals(a: unknown, b: unknown): boolean {
    const ta = a as TypeLattice;
    const tb = b as TypeLattice;
    return (
      ta === tb ||
      (ta.kinds === tb.kinds &&
        ta.intRef === tb.intRef &&
        ta.boolRef === tb.boolRef &&
        ta.floatRef === tb.floatRef)
    );
  }
  readonly mergeKind = "may" as const;
  readonly direction = "forward" as const;
  top(): TypeLattice {
    return TOP;
  }
  bottom(): TypeLattice {
    return BOTTOM;
  }
  join(a: TypeLattice, b: TypeLattice): TypeLattice {
    return join(a, b);
  }
  meet(a: TypeLattice, b: TypeLattice): TypeLattice {
    return meet(a, b);
  }
  leq(a: TypeLattice, b: TypeLattice): boolean {
    return leq(a, b);
  }

  makeExprVisitor(
    hints: HintStore,
    env: { get(slot: number): TypeLattice | undefined },
    slotLookup: SlotLookup,
  ): ExprNS.Visitor<TypeLattice> {
    return new TypeAnalysisVisitor(hints, env, slotLookup);
  }

  observeWrite(hint: OptimizationHint, rawValue: unknown): OptimizationHint {
    const value = liftType(rawValue);
    if (value === undefined) return hint;
    // Widen (join) — observations add seen values, never narrow static facts.
    const prev = hint.type;
    const next = prev ? join(prev, value) : value;
    return { ...hint, type: next };
  }
}

// CSE stack values are tagged objects with `.type` discriminator.
// Duck-type on the tag to avoid an engine → framework import.
function liftType(rawValue: unknown): TypeLattice | undefined {
  if (rawValue === null || rawValue === undefined) return nullValue();
  if (typeof rawValue === "number") return rawToNumberLattice(rawValue);
  if (typeof rawValue === "boolean") return rawValue ? trueValue() : falseValue();
  if (typeof rawValue === "string") return stringValue();
  if (typeof rawValue === "bigint") return rawToNumberLattice(Number(rawValue));
  if (typeof rawValue !== "object") return undefined;

  const tagged = rawValue as { type?: string; value?: unknown };
  switch (tagged.type) {
    case "number":
      return typeof tagged.value === "number" ? rawToNumberLattice(tagged.value) : undefined;
    case "bigint":
      return typeof tagged.value === "bigint"
        ? rawToNumberLattice(Number(tagged.value))
        : undefined;
    case "bool":
      return tagged.value === true
        ? trueValue()
        : tagged.value === false
          ? falseValue()
          : undefined;
    case "string":
      return stringValue();
    case "none":
      return nullValue();
    case "closure":
    case "function":
    case "multi_lambda":
    case "builtin":
      return closureValue();
    case "complex":
      return complexValue();
    default:
      return undefined;
  }
}

function rawToNumberLattice(value: number): TypeLattice {
  if (Number.isInteger(value) && Number.isFinite(value)) {
    return value > 0 ? positiveInteger() : value < 0 ? negativeInteger() : zeroInteger();
  }
  if (Number.isNaN(value)) return floatValue();
  return value > 0 ? positiveFloat() : value < 0 ? negativeFloat() : zeroFloat();
}
