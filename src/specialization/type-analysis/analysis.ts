import { ExprNS } from "../../ast-types";
import { TokenType } from "../../tokens";
import type { FactStore } from "../framework/fact-store";
import type { Lattice, Pass, PassCtx } from "../framework/pass";
import { runtimeWritePass } from "../framework/runtime-passes";
import { structuralPass } from "../framework/structural-pass";
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

const typeLattice: Lattice<TypeLattice> = {
  bottom: BOTTOM,
  equals: (a, b) =>
    a === b ||
    (a.kinds === b.kinds &&
      a.intRef === b.intRef &&
      a.boolRef === b.boolRef &&
      a.floatRef === b.floatRef),
  join,
};

export const typeAnalysisPass: Pass<number, TypeLattice> = {
  id: Symbol("typeAnalysisPass"),
  debugName: "typeAnalysisPass",
  lattice: typeLattice,
  reads: [runtimeWritePass, structuralPass],
  tier: "analysis",
  coarse: true,
  transfer(_ctx: PassCtx, _key: number): TypeLattice | undefined {
    return undefined;
  },
};

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

class TypeAnalysisVisitor implements ExprNS.Visitor<TypeLattice> {
  constructor(
    private readonly factStore: FactStore,
    private readonly slotTypes: { get(slot: number): TypeLattice | undefined },
    private readonly slotLookup: SlotLookup,
  ) {}

  private annotate(node: ExprNS.Expr, val: TypeLattice): TypeLattice {
    const observed = this.factStore.tryRead(runtimeWritePass, node.id);
    const widened = observed !== undefined
      ? join(val, liftType(observed) ?? BOTTOM)
      : val;
    this.factStore.write(typeAnalysisPass, node.id, widened);
    return widened;
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

    // str+str → string (handled before numeric dispatch).
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

// Forward may-analysis: env join = union; specialize only when numeric on all paths.
export class TypeAnalysisPass implements AnalysisPass<TypeLattice> {
  readonly name = "type";
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
    factStore: FactStore,
    env: { get(slot: number): TypeLattice | undefined },
    slotLookup: SlotLookup,
  ): ExprNS.Visitor<TypeLattice> {
    return new TypeAnalysisVisitor(factStore, env, slotLookup);
  }
}

// Duck-type CSE stack values via `.type` discriminator (avoids engine→framework import).
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
