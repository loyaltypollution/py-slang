import { ExprNS } from "../../ast-types";
import { TokenType } from "../../tokenizer";
import type { AssumptionChain } from "../framework/assumption-chain";
import type { BlockDfaSpec } from "../framework/dfa-factory";
import { MutableEnv } from "../framework/mutable-env";
import type { RawKind } from "../framework/raw-value";
import { isLocal, type SlotLookup } from "../framework/slot-table";
import { type NodeId } from "../framework/key-spaces";
import { transferBlock } from "../framework/block-transfer";
import { makeBlockFixpointAnalysis, type BlockFixpointAnalysis } from "../framework/dfa-factory";
import {
  type ConstLattice,
  CONST_BOTTOM,
  CONST_TOP,
  constJoin,
  constLeq,
  constEq,
  constOf,
} from "./lattice";

export function liftConst(observed: RawKind): ConstLattice | undefined {
  switch (observed.kind) {
    case "number":
      return constOf(observed.value);
    default:
      return undefined;
  }
}

/** Baseline const facts are semantic-only. There is no chain-extension
 *  narrowing for const under POC: a concrete-value speculation
 *  (`paramConstNarrowing` was the candidate) thrashes recursively — e.g.
 *  `f(x)` calling `f(x-1)` observes a different concrete value per frame
 *  and the chain binding invalidates every call. The type lattice has
 *  finite height and is stable across value variation, so param
 *  speculation lives on `paramTypeNarrowing` exclusively. `constAnalysis`
 *  remains useful as a static (chain-invariant) pass driving
 *  `constantFoldingRule`, `deadStoreRule`, and `algebraicSimplifyRule`. */

const constMeet = (a: ConstLattice, b: ConstLattice): ConstLattice => {
  if (a.tag === "top") return b;
  if (b.tag === "top") return a;
  if (a.tag === "bottom" || b.tag === "bottom") return CONST_BOTTOM;
  return a.value === b.value ? a : CONST_BOTTOM;
};

class ConstAnalysisVisitor implements ExprNS.Visitor<ConstLattice> {
  constructor(
    private readonly constEnv: MutableEnv<ConstLattice>,
    private readonly slotLookup: SlotLookup,
    private readonly recordExprFact: (nodeId: NodeId, val: ConstLattice) => void,
  ) {}

  private annotate(node: ExprNS.Expr, val: ConstLattice): ConstLattice {
    this.recordExprFact(node.id, val);
    return val;
  }

  visitLiteralExpr(expr: ExprNS.Literal): ConstLattice {
    if (typeof expr.value === "number") {
      return this.annotate(expr, constOf(expr.value));
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

    return this.annotate(expr, CONST_TOP);
  }

  // Compare produces a boolean; boolean facts live in TypeAnalysis (BoolRef).
  visitCompareExpr(expr: ExprNS.Compare): ConstLattice {
    expr.left.accept(this);
    expr.right.accept(this);
    return this.annotate(expr, CONST_TOP);
  }

  visitUnaryExpr(expr: ExprNS.Unary): ConstLattice {
    const operand = expr.right.accept(this);
    if (operand.tag !== "const") return this.annotate(expr, CONST_TOP);
    switch (expr.operator.type) {
      case TokenType.MINUS:
        return this.annotate(expr, constOf(-operand.value));
      case TokenType.PLUS:
        return this.annotate(expr, constOf(+operand.value));
    }
    return this.annotate(expr, CONST_TOP);
  }

  // `and`/`or` truthiness reasoning lives in TypeAnalysis's BoolRef transfer.
  visitBoolOpExpr(expr: ExprNS.BoolOp): ConstLattice {
    expr.left.accept(this);
    expr.right.accept(this);
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
  meet: constMeet,
  leq: constLeq,
  eq: constEq,
  makeExprVisitor(
    env: MutableEnv<ConstLattice>,
    _unit,
    slotLookup: SlotLookup,
    recordExprFact: (nodeId: NodeId, val: ConstLattice) => void,
    _context: AssumptionChain,
  ): ExprNS.Visitor<ConstLattice> {
    return new ConstAnalysisVisitor(env, slotLookup, recordExprFact);
  },
  refineOnEdge(env, _edge) {
    return env;
  },
};

/** Block-level fixpoint analysis for const narrowing. Owned here (at the
 *  dimension's source) so the narrowing's `blockAnalysis` thunk has a
 *  stable local binding. */
export const constAnalysis: BlockFixpointAnalysis<ConstLattice> =
  makeBlockFixpointAnalysis<ConstLattice>({
    direction: constAnalysisModule.direction,
    valueLattice: constAnalysisModule,
    mergeKind: constAnalysisModule.mergeKind,
    seedEnv: () => new MutableEnv<ConstLattice>(),
    transferBlock: (ctx, block, inEnv, unit) =>
      transferBlock(block, inEnv, constAnalysisModule, unit, ctx.currentContext),
    refineOnEdge: (env, edge) => constAnalysisModule.refineOnEdge(env, edge),
  });
