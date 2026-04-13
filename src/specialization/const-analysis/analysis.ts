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
  type ConstLattice,
  CONST_TOP,
  constJoin,
  constLeq,
  constMeet,
  constOf,
} from "./lattice";

export { constJoin, constLeq, constMeet };

// ── Expression-level visitor ──────────────────────────────────────────────────

class ConstAnalysisVisitor implements ExprNS.Visitor<ConstLattice> {
  constructor(
    private readonly constEnv: { get(slot: number): ConstLattice | undefined },
    private readonly slotLookup: SlotLookup,
    private readonly observations: ReadonlyMap<number, unknown>,
    private readonly tap?: (id: number, val: ConstLattice) => void,
  ) {}

  private annotate(node: ExprNS.Expr, val: ConstLattice): ConstLattice {
    const observed = this.observations.get(node.id);
    const lifted = observed !== undefined ? liftConst(observed) : undefined;
    const widened = lifted !== undefined ? constJoin(val, lifted) : val;
    if (this.tap) this.tap(node.id, widened);
    return widened;
  }

  visitLiteralExpr(expr: ExprNS.Literal): ConstLattice {
    const v = expr.value;
    if (typeof v === "number" || typeof v === "boolean" || typeof v === "string") {
      return this.annotate(expr, constOf(v));
    }
    return this.annotate(expr, CONST_TOP);
  }

  visitBigIntLiteralExpr(expr: ExprNS.BigIntLiteral): ConstLattice {
    return this.annotate(expr, constOf(Number(expr.value)));
  }

  visitVariableExpr(expr: ExprNS.Variable): ConstLattice {
    const info = this.slotLookup(expr.name);
    if (info.isPrimitive || info.envLevel !== 0) return this.annotate(expr, CONST_TOP);
    return this.annotate(expr, this.constEnv.get(info.slot) ?? CONST_TOP);
  }

  visitBinaryExpr(expr: ExprNS.Binary): ConstLattice {
    const left = expr.left.accept(this);
    const right = expr.right.accept(this);

    if (left.tag !== "const" || right.tag !== "const") {
      return this.annotate(expr, CONST_TOP);
    }

    const lv = left.value;
    const rv = right.value;

    if (typeof lv === "number" && typeof rv === "number") {
      switch (expr.operator.type) {
        case TokenType.PLUS:
          return this.annotate(expr, constOf(lv + rv));
        case TokenType.MINUS:
          return this.annotate(expr, constOf(lv - rv));
        case TokenType.STAR:
          return this.annotate(expr, constOf(lv * rv));
        case TokenType.SLASH:
          if (rv === 0) return this.annotate(expr, CONST_TOP);
          return this.annotate(expr, constOf(lv / rv));
        case TokenType.DOUBLESLASH:
          if (rv === 0) return this.annotate(expr, CONST_TOP);
          return this.annotate(expr, constOf(Math.floor(lv / rv)));
        case TokenType.PERCENT: {
          if (rv === 0) return this.annotate(expr, CONST_TOP);
          // Python modulo: result has same sign as divisor
          return this.annotate(expr, constOf(lv - Math.floor(lv / rv) * rv));
        }
      }
    }

    if (typeof lv === "string" && typeof rv === "string" && expr.operator.type === TokenType.PLUS) {
      return this.annotate(expr, constOf(lv + rv));
    }

    return this.annotate(expr, CONST_TOP);
  }

  visitCompareExpr(expr: ExprNS.Compare): ConstLattice {
    const left = expr.left.accept(this);
    const right = expr.right.accept(this);

    if (left.tag !== "const" || right.tag !== "const") {
      return this.annotate(expr, CONST_TOP);
    }

    const lv = left.value;
    const rv = right.value;

    switch (expr.operator.type) {
      case TokenType.LESS:
        return this.annotate(expr, constOf(lv < rv));
      case TokenType.GREATER:
        return this.annotate(expr, constOf(lv > rv));
      case TokenType.LESSEQUAL:
        return this.annotate(expr, constOf(lv <= rv));
      case TokenType.GREATEREQUAL:
        return this.annotate(expr, constOf(lv >= rv));
      case TokenType.DOUBLEEQUAL:
        return this.annotate(expr, constOf(lv === rv));
      case TokenType.NOTEQUAL:
        return this.annotate(expr, constOf(lv !== rv));
      default:
        return this.annotate(expr, CONST_TOP);
    }
  }

  visitUnaryExpr(expr: ExprNS.Unary): ConstLattice {
    const operand = expr.right.accept(this);
    if (operand.tag !== "const") return this.annotate(expr, CONST_TOP);
    const v = operand.value;
    switch (expr.operator.type) {
      case TokenType.MINUS:
        if (typeof v === "number") return this.annotate(expr, constOf(-v));
        break;
      case TokenType.PLUS:
        if (typeof v === "number") return this.annotate(expr, constOf(+v));
        break;
      case TokenType.NOT:
        return this.annotate(expr, constOf(!v));
    }
    return this.annotate(expr, CONST_TOP);
  }

  visitBoolOpExpr(expr: ExprNS.BoolOp): ConstLattice {
    const left = expr.left.accept(this);
    // Evaluate right regardless to annotate its sub-expressions
    const right = expr.right.accept(this);
    if (left.tag !== "const") return this.annotate(expr, CONST_TOP);
    if (expr.operator.type === TokenType.AND) {
      return this.annotate(expr, left.value ? right : left);
    }
    if (expr.operator.type === TokenType.OR) {
      return this.annotate(expr, left.value ? left : right);
    }
    return this.annotate(expr, CONST_TOP);
  }

  visitGroupingExpr(expr: ExprNS.Grouping): ConstLattice {
    const val = expr.expression.accept(this);
    return this.annotate(expr, val);
  }

  visitTernaryExpr(expr: ExprNS.Ternary): ConstLattice {
    expr.predicate.accept(this);
    expr.consequent.accept(this);
    expr.alternative.accept(this);
    return this.annotate(expr, CONST_TOP);
  }

  visitCallExpr(expr: ExprNS.Call): ConstLattice {
    expr.callee.accept(this);
    for (const arg of expr.args) arg.accept(this);
    return this.annotate(expr, CONST_TOP);
  }

  visitListExpr(expr: ExprNS.List): ConstLattice {
    for (const el of expr.elements) el.accept(this);
    return this.annotate(expr, CONST_TOP);
  }

  visitSubscriptExpr(expr: ExprNS.Subscript): ConstLattice {
    expr.value.accept(this);
    expr.index.accept(this);
    return this.annotate(expr, CONST_TOP);
  }

  visitStarredExpr(expr: ExprNS.Starred): ConstLattice {
    expr.value.accept(this);
    return this.annotate(expr, CONST_TOP);
  }

  visitNoneExpr(expr: ExprNS.None): ConstLattice {
    return this.annotate(expr, CONST_TOP);
  }

  visitComplexExpr(expr: ExprNS.Complex): ConstLattice {
    return this.annotate(expr, CONST_TOP);
  }

  visitLambdaExpr(expr: ExprNS.Lambda): ConstLattice {
    return this.annotate(expr, CONST_TOP);
  }

  visitMultiLambdaExpr(expr: ExprNS.MultiLambda): ConstLattice {
    return this.annotate(expr, CONST_TOP);
  }
}

function constSpec(
  observations: ReadonlyMap<number, unknown>,
  slotLookup: SlotLookup,
): BlockTransferSpec<ConstLattice> {
  return {
    top: CONST_TOP,
    direction: "forward",
    makeVisitor(env, tap) {
      return new ConstAnalysisVisitor(env, slotLookup, observations, tap);
    },
  };
}

/**
 * Pure block transfer for the runtime Query world. See the matching
 * helper in type-analysis/analysis.ts for the full rationale.
 */
export function transferBlockWithObservations(
  block: BasicBlock,
  inEnv: MutableEnv<ConstLattice>,
  slotLookup: SlotLookup,
  observations: ReadonlyMap<number, unknown>,
): MutableEnv<ConstLattice> {
  return transferBlock(block, inEnv, constSpec(observations, slotLookup), slotLookup);
}

/** Const-lattice analogue of `nodeTypeFactsForBlock`. */
export function nodeConstFactsForBlock(
  block: BasicBlock,
  inEnv: MutableEnv<ConstLattice>,
  slotLookup: SlotLookup,
  observations: ReadonlyMap<number, unknown>,
): ReadonlyMap<number, ConstLattice> {
  const out = new Map<number, ConstLattice>();
  transferBlock(
    block,
    inEnv,
    constSpec(observations, slotLookup),
    slotLookup,
    (id, val) => {
      out.set(id, val);
    },
  );
  return out;
}

function liftConst(rawValue: unknown): ConstLattice | undefined {
  if (
    typeof rawValue === "number" ||
    typeof rawValue === "boolean" ||
    typeof rawValue === "string"
  ) {
    return constOf(rawValue);
  }
  if (typeof rawValue === "bigint") return constOf(Number(rawValue));
  if (typeof rawValue !== "object" || rawValue === null) return undefined;

  const tagged = rawValue as { type?: string; value?: unknown };
  switch (tagged.type) {
    case "number":
    case "string":
      return typeof tagged.value === "number" || typeof tagged.value === "string"
        ? constOf(tagged.value)
        : undefined;
    case "bool":
      return typeof tagged.value === "boolean" ? constOf(tagged.value) : undefined;
    case "bigint":
      return typeof tagged.value === "bigint" ? constOf(Number(tagged.value)) : undefined;
    default:
      return undefined;
  }
}
