import { ExprNS } from "../../ast-types";
import { TokenType } from "../../tokens";
import type { FactStore } from "../framework/fact-store";
import type { Lattice } from "../framework/pass";
import { runtimeWritePass } from "../framework/runtime-passes";
import type { BlockDfaSpec, SlotEnv } from "../framework/interfaces";
import type { RawKind } from "../framework/raw-value";
import { isLocal, type SlotLookup } from "../framework/slot-table";
import {
  type TypeLattice,
  boolean as booleanValue,
  BOOL_FALSE,
  BOOL_TRUE,
  BoolRef,
  BOTTOM,
  CLOSURE,
  COMPLEX,
  FLOAT_NEG,
  FLOAT_POS,
  FLOAT_ZERO,
  floatValue,
  INT_NEG,
  INT_POS,
  INT_ZERO,
  join,
  leq,
  meet,
  NULL,
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

export const typeLatticeAlgebra: Lattice<TypeLattice> = {
  bottom: BOTTOM,
  leq,
  join,
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
    private readonly slotTypes: SlotEnv<TypeLattice>,
    private readonly slotLookup: SlotLookup,
    private readonly recordExprFact: (nodeId: number, val: TypeLattice) => void,
  ) {}

  private annotate(node: ExprNS.Expr, val: TypeLattice): TypeLattice {
    const observed = this.factStore.tryRead(runtimeWritePass, node.id);
    const widened = observed !== undefined
      ? join(val, liftType(observed) ?? BOTTOM)
      : val;
    this.recordExprFact(node.id, widened);
    return widened;
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

  visitVariableExpr(expr: ExprNS.Variable): TypeLattice {
    const info = this.slotLookup(expr.name);
    if (!isLocal(info)) return this.annotate(expr, TOP);
    const slotInfo = this.slotTypes.get(info.slot) ?? TOP;
    return this.annotate(expr, slotInfo);
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

    return this.annotate(expr, booleanValue(BoolRef.Top));
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
  // Both operands are always visited so downstream passes receive
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

// Forward may-analysis: env join = union; specialize only when numeric on all paths.
export const typeAnalysisModule: BlockDfaSpec<TypeLattice> = {
  mergeKind: "may",
  direction: "forward",
  bottom: BOTTOM,
  top: TOP,
  join,
  meet,
  leq,
  makeExprVisitor(
    factStore: FactStore,
    env: SlotEnv<TypeLattice>,
    slotLookup: SlotLookup,
    recordExprFact: (nodeId: number, val: TypeLattice) => void,
  ): ExprNS.Visitor<TypeLattice> {
    return new TypeAnalysisVisitor(factStore, env, slotLookup, recordExprFact);
  },
  // Identity: type narrowing from `if x > 0` etc. lands in a later commit.
  refineOnEdge(env, _edge) {
    return env;
  },
};

function liftType(rawKind: RawKind): TypeLattice | undefined {
  switch (rawKind.kind) {
    case "number":
      return rawToNumberLattice(rawKind.value);
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

function rawToNumberLattice(value: number): TypeLattice {
  if (Number.isInteger(value) && Number.isFinite(value)) {
    return value > 0 ? INT_POS : value < 0 ? INT_NEG : INT_ZERO;
  }
  if (Number.isNaN(value)) return floatValue();
  return value > 0 ? FLOAT_POS : value < 0 ? FLOAT_NEG : FLOAT_ZERO;
}
