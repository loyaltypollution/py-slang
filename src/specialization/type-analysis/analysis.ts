import { ExprNS } from "../../ast-types";
import { TokenType } from "../../tokens";
import {
  type TypeLattice,
  BOOL_BIT,
  BoolRef,
  STR_BIT,
  boolean as booleanValue,
  closureValue,
  complexValue,
  falseValue,
  floatValue,
  join,
  meet,
  leq,
  negativeFloat,
  negativeInteger,
  nullValue,
  positiveFloat,
  positiveInteger,
  stringValue,
  TOP,
  BOTTOM,
  trueValue,
  zeroFloat,
  zeroInteger,
} from "./lattice";
import { transferBinaryOp, transferCompare, transferNot, transferUnaryNeg } from "./transfer";
import type { AnalysisModule } from "../framework/interfaces";
import type { HintStore } from "../framework/hint";
import type { SlotLookup } from "../framework/slot-table";

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

/**
 * Implements ExprNS.Visitor<TypeLattice>, replacing the hand-threaded switch-dispatch
 * in the legacy ASTSpecializationVisitor. TypeScript enforces exhaustiveness: every
 * expression node type must have a corresponding visitXxx method. Missing a node type
 * is a compile error, unlike the switch on expr.kind which is unchecked.
 */
export class TypeAnalysisVisitor implements ExprNS.Visitor<TypeLattice> {
  constructor(
    private readonly hints: HintStore,
    private readonly slotTypes: { get(slot: number): TypeLattice | undefined },
    private readonly slotLookup: SlotLookup,
  ) {}

  private annotate(node: ExprNS.Expr, val: TypeLattice): TypeLattice {
    const existing = this.hints.get(node);
    this.hints.set(node, { ...existing, type: val });
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
 * Type analysis AnalysisModule: wraps TypeAnalysisVisitor transfer functions
 * in the AnalysisModule interface. Lattice operations delegate to lattice.ts.
 *
 * This is a forward May analysis: merge = join (least upper bound).
 * At join points (if/else, loop headers) the env takes the union of possible types,
 * so we specialize only when the type is known to be numeric on ALL incoming paths.
 */
export class TypeAnalysisModule implements AnalysisModule<TypeLattice> {
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
    hints: HintStore,
    env: { get(slot: number): TypeLattice | undefined },
    slotLookup: SlotLookup,
  ): ExprNS.Visitor<TypeLattice> {
    return new TypeAnalysisVisitor(hints, env, slotLookup);
  }
}
