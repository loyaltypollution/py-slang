import { ExprNS } from "../../ast-types";
import { TokenType } from "../../tokens";
import type { BasicBlock } from "../framework/cfg";
import {
  type BlockTransferSpec,
  transferBlock,
} from "../framework/block-transfer";
import type { MutableEnv } from "../framework/mutable-env";
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

/**
 * Expression visitor for forward type analysis. Each `annotate` site
 * widens the static value with any matching runtime observation
 * (`observations.get(node.id)`) and emits to the optional `tap`.
 *
 * Pure with respect to its inputs: the observations map is read-only
 * and the tap is the only way per-node facts escape the visitor.
 */
class TypeAnalysisVisitor implements ExprNS.Visitor<TypeLattice> {
  constructor(
    private readonly slotTypes: { get(slot: number): TypeLattice | undefined },
    private readonly slotLookup: SlotLookup,
    private readonly observations: ReadonlyMap<number, unknown>,
    private readonly tap?: (id: number, val: TypeLattice) => void,
  ) {}

  private annotate(node: ExprNS.Expr, val: TypeLattice): TypeLattice {
    const observed = this.observations.get(node.id);
    const widened = observed !== undefined
      ? join(val, liftType(observed) ?? BOTTOM)
      : val;
    if (this.tap) this.tap(node.id, widened);
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

function typeSpec(
  observations: ReadonlyMap<number, unknown>,
  slotLookup: SlotLookup,
): BlockTransferSpec<TypeLattice> {
  return {
    top: TOP,
    direction: "forward",
    makeVisitor(env, tap) {
      return new TypeAnalysisVisitor(env, slotLookup, observations, tap);
    },
  };
}

/**
 * Pure block transfer for the runtime Query world. Takes runtime
 * observations as an explicit `ReadonlyMap<NodeId, unknown>` — no
 * FactStore, no Pass tokens — and returns the exit env. The query
 * runtime preregisters dep edges on `runtimeWrite` for every reachable
 * NodeId before invoking this so observations invalidate the DFA.
 */
export function transferBlockWithObservations(
  block: BasicBlock,
  inEnv: MutableEnv<TypeLattice>,
  slotLookup: SlotLookup,
  observations: ReadonlyMap<number, unknown>,
): MutableEnv<TypeLattice> {
  return transferBlock(block, inEnv, typeSpec(observations, slotLookup), slotLookup);
}

/**
 * Replay a block's transfer with a tap that captures per-node facts.
 * Used by the runtime `typeOf` query to project lattice values at node
 * granularity. Returns the tapped (nodeId → value) map; later writes
 * within the same block supersede earlier ones (last-write-wins).
 */
export function nodeTypeFactsForBlock(
  block: BasicBlock,
  inEnv: MutableEnv<TypeLattice>,
  slotLookup: SlotLookup,
  observations: ReadonlyMap<number, unknown>,
): ReadonlyMap<number, TypeLattice> {
  const out = new Map<number, TypeLattice>();
  transferBlock(
    block,
    inEnv,
    typeSpec(observations, slotLookup),
    slotLookup,
    (id, val) => {
      out.set(id, val);
    },
  );
  return out;
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
