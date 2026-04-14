import { ExprNS } from "../../ast-types";
import { TokenType } from "../../tokens";
import type { FactStore } from "../framework/fact-store";
import { runtimeWritePass } from "../framework/runtime-passes";
import type { BlockDfaSpec } from "../framework/interfaces";
import type { MutableEnv } from "../framework/mutable-env";
import { isLocal, type SlotLookup } from "../framework/slot-table";
import {
  type ConstLattice,
  CONST_BOTTOM,
  CONST_TOP,
  constJoin,
  constOf,
} from "./lattice";

class ConstAnalysisVisitor implements ExprNS.Visitor<ConstLattice> {
  constructor(
    private readonly factStore: FactStore,
    private readonly constEnv: MutableEnv<ConstLattice>,
    private readonly slotLookup: SlotLookup,
    private readonly recordExprFact: (nodeId: number, val: ConstLattice) => void,
  ) {}

  private annotate(node: ExprNS.Expr, val: ConstLattice): ConstLattice {
    const observed = this.factStore.tryRead(runtimeWritePass, node.id);
    let lifted: ConstLattice | undefined;
    if (observed !== undefined) {
      switch (observed.kind) {
        case "number":
        case "bool":
          lifted = constOf(observed.value);
          break;
        case "string":
          lifted = observed.value !== undefined ? constOf(observed.value) : undefined;
          break;
      }
    }
    const widened = lifted !== undefined ? constJoin(val, lifted) : val;
    this.recordExprFact(node.id, widened);
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
    if (!isLocal(info)) return this.annotate(expr, CONST_TOP);
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

  // Const-analysis tracks concrete *values* through `and`/`or` (Python
  // semantics: `a and b` yields `a` when falsy else `b`). Both operands are
  // always visited so sub-expressions get annotated for downstream passes.
  // See type-analysis `visitBoolOpExpr` for the parallel boolRef-narrowing
  // view — the two are complementary, not duplicates.
  visitBoolOpExpr(expr: ExprNS.BoolOp): ConstLattice {
    const left = expr.left.accept(this);
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

export const constAnalysisModule: BlockDfaSpec<ConstLattice> = {
  mergeKind: "may",
  direction: "forward",
  bottom: CONST_BOTTOM,
  top: CONST_TOP,
  join: constJoin,
  meet: (a, b) => {
    if (a.tag === "top") return b;
    if (b.tag === "top") return a;
    if (a.tag === "bottom" || b.tag === "bottom") return CONST_BOTTOM;
    return a.value === b.value ? a : CONST_BOTTOM;
  },
  leq: (a, b) => {
    if (a.tag === "bottom") return true;
    if (b.tag === "top") return true;
    if (a.tag === "top") return false;
    if (b.tag === "bottom") return false;
    return a.value === b.value;
  },
  makeExprVisitor(
    factStore: FactStore,
    env: MutableEnv<ConstLattice>,
    slotLookup: SlotLookup,
    recordExprFact: (nodeId: number, val: ConstLattice) => void,
  ): ExprNS.Visitor<ConstLattice> {
    return new ConstAnalysisVisitor(factStore, env, slotLookup, recordExprFact);
  },
  refineOnEdge(env, _edge) {
    return env;
  },
};
