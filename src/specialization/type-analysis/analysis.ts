import { ExprNS } from "../../ast-types";
import { TokenType } from "../../tokens";
import type { BasicBlock } from "../framework/cfg";
import { FactStore } from "../framework/fact-store";
import { typeAnalysisPass } from "../framework/migrated-passes";
import { runtimeWritePass } from "../framework/runtime-passes";
import type { AnalysisPass } from "../framework/interfaces";
import { transferBlock } from "../framework/block-transfer";
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
    private readonly factStore: FactStore,
    private readonly slotTypes: { get(slot: number): TypeLattice | undefined },
    private readonly slotLookup: SlotLookup,
    /**
     * Per-node tap. When supplied (e.g. by `nodeFactView.get`'s replay), the
     * visitor emits to the tap and skips the fact-store write — the View
     * gates publication itself. When absent (legacy driver), `annotate`
     * publishes to the fact store as before.
     */
    private readonly tap?: (id: number, val: TypeLattice) => void,
  ) {}

  private annotate(node: ExprNS.Expr, val: TypeLattice): TypeLattice {
    const observed = this.factStore.tryRead(runtimeWritePass, node.id);
    const widened = observed !== undefined
      ? join(val, liftType(observed) ?? BOTTOM)
      : val;
    if (this.tap) this.tap(node.id, widened);
    else this.factStore.write(typeAnalysisPass, node.id, widened);
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
    factStore: FactStore,
    env: { get(slot: number): TypeLattice | undefined },
    slotLookup: SlotLookup,
    tap?: (id: number, val: TypeLattice) => void,
  ): ExprNS.Visitor<TypeLattice> {
    return new TypeAnalysisVisitor(factStore, env, slotLookup, tap);
  }

}

/**
 * Pure block transfer for the runtime Query world (Phase 3b).
 *
 * Unlike the legacy path — which reads `runtimeWritePass` from a shared
 * `FactStore` and writes facts back into it — this helper takes observations
 * as an explicit `ReadonlyMap<NodeId, unknown>` and discards the visitor's
 * per-node tap output. The query runtime records dep edges by pulling
 * `runtimeWrite` entries for reachable NodeIds before invoking this.
 *
 * Implemented by constructing an ephemeral FactStore pre-seeded with the
 * observations under `runtimeWritePass`, then delegating to `transferBlock`
 * with a no-op tap so no `typeAnalysisPass` writes leak into the store.
 * Additive — does not alter behavior of existing exports.
 */
export function transferBlockPureType(
  block: BasicBlock,
  inEnv: MutableEnv<TypeLattice>,
  slotLookup: SlotLookup,
  observations: ReadonlyMap<number, unknown>,
): MutableEnv<TypeLattice> {
  const factStore = new FactStore();
  for (const [id, val] of observations) {
    factStore.write(runtimeWritePass, id, val);
  }
  const pass = new TypeAnalysisPass();
  return transferBlock(block, inEnv, pass, factStore, slotLookup, () => {
    // tap swallows per-node facts; the query returns exit env only
  });
}

/**
 * Replay a block's transfer with a tap that captures per-node facts. Used by
 * runtime `typeOf` to project lattice values at node granularity. Mirrors
 * `transferBlockPureType` but returns the tapped (nodeId → value) map
 * instead of the exit env. Additive.
 */
export function nodeTypeFactsForBlock(
  block: BasicBlock,
  inEnv: MutableEnv<TypeLattice>,
  slotLookup: SlotLookup,
  observations: ReadonlyMap<number, unknown>,
): ReadonlyMap<number, TypeLattice> {
  const factStore = new FactStore();
  for (const [id, val] of observations) {
    factStore.write(runtimeWritePass, id, val);
  }
  const pass = new TypeAnalysisPass();
  const out = new Map<number, TypeLattice>();
  transferBlock(block, inEnv, pass, factStore, slotLookup, (id, val) => {
    // Later writes in the same block supersede earlier ones for the same id;
    // this matches the visitor's last-write-wins annotate semantics.
    out.set(id, val);
  });
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
