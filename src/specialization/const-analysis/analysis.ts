import { ExprNS, StmtNS } from "../../ast-types";
import { TokenType } from "../../tokens";
import type { Narrowing } from "../framework/analysis";
import { findAssumption, ROOT_CONTEXT, type AssumptionChain } from "../framework/context";
import { paramConstNarrowing } from "../framework/param-handles";
import type { BlockDfaSpec } from "../framework/interfaces";
import { MutableEnv } from "../framework/mutable-env";
import type { RawKind } from "../framework/raw-value";
import { isLocal, type SlotLookup } from "../framework/slot-table";
import { paramKey, type FunctionId, type NodeId } from "../framework/key-spaces";
import { transferBlock } from "../framework/block-transfer";
import { makeBlockFixpointAnalysis, type BlockFixpointAnalysis } from "../framework/dfa-factory";
import { runtimeWriteAnalysis } from "../framework/runtime-analyses";
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
    case "bool":
      return constOf(observed.value);
    case "string":
      return observed.value !== undefined ? constOf(observed.value) : undefined;
    default:
      return undefined;
  }
}

/** Runtime observations no longer strengthen ROOT const facts. Baseline const
 *  facts are semantic-only; runtime/profile input participates through
 *  revocable non-ROOT Context assumptions instead. */

export const constMeet = (a: ConstLattice, b: ConstLattice): ConstLattice => {
  if (a.tag === "top") return b;
  if (b.tag === "top") return a;
  if (a.tag === "bottom" || b.tag === "bottom") return CONST_BOTTOM;
  return a.value === b.value ? a : CONST_BOTTOM;
};

/** Const-narrowing dimension. Identity token used by AssumptionChain
 *  (`findAssumption(context, constNarrowing, nodeId)`) AND the narrowing
 *  record the worklist's observation→context translator consumes. The
 *  `blockAnalysis` thunk is evaluated at call time, so the self-reference
 *  to `constAnalysis` below is safe despite declaration order. */
export const constNarrowing: Narrowing<NodeId, ConstLattice> = {
  id: Symbol("constNarrowing"),
  debugName: "constNarrowing",
  keySpace: "nodeId",
  eq: constEq,
  blockAnalysis: () => constAnalysis,
  observationSource: runtimeWriteAnalysis,
  lift: liftConst,
};

class ConstAnalysisVisitor implements ExprNS.Visitor<ConstLattice> {
  constructor(
    private readonly constEnv: MutableEnv<ConstLattice>,
    private readonly functionId: FunctionId,
    private readonly paramCount: number,
    private readonly slotLookup: SlotLookup,
    private readonly recordExprFact: (nodeId: NodeId, val: ConstLattice) => void,
    private readonly context: AssumptionChain,
  ) {}

  /** ROOT facts are purely semantic. Non-ROOT contexts may narrow them via
   *  assumptions carried in the Context chain. */
  private annotate(node: ExprNS.Expr, val: ConstLattice): ConstLattice {
    const assumption = this.context === ROOT_CONTEXT
      ? undefined
      : findAssumption(this.context, constNarrowing, node.id);
    const combined = assumption !== undefined ? constMeet(val, assumption) : val;
    this.recordExprFact(node.id, combined);
    return combined;
  }

  private paramAssumption(slot: number): ConstLattice | undefined {
    if (this.context === ROOT_CONTEXT || slot < 0 || slot >= this.paramCount) return undefined;
    return findAssumption(this.context, paramConstNarrowing, paramKey(this.functionId, slot));
  }

  private annotateWithParamAssumption(node: ExprNS.Expr, val: ConstLattice, slot: number): ConstLattice {
    const param = this.paramAssumption(slot);
    const combined = param !== undefined ? constMeet(val, param) : val;
    return this.annotate(node, combined);
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
    return this.annotateWithParamAssumption(expr, this.constEnv.get(info.slot) ?? CONST_TOP, info.slot);
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

  // Python short-circuit: `a and b` yields `a` if falsy else `b`; `a or b`
  // yields `a` if truthy else `b`. Both operands are visited for annotation
  // even when the short-circuit decides the result. Parallel to
  // type-analysis `visitBoolOpExpr`, which handles the boolRef-narrowing view.
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

export function makeConstAnalysisModule(): BlockDfaSpec<ConstLattice> {
  return {
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
      unit,
      slotLookup: SlotLookup,
      recordExprFact: (nodeId: NodeId, val: ConstLattice) => void,
      context: AssumptionChain,
    ): ExprNS.Visitor<ConstLattice> {
      return new ConstAnalysisVisitor(
        env,
        unit.funcAst.id,
        unit.funcAst instanceof StmtNS.FunctionDef ? unit.funcAst.parameters.length : 0,
        slotLookup,
        recordExprFact,
        context,
      );
    },
    refineOnEdge(env, _edge) {
      return env;
    },
  };
}

export const constAnalysisModule: BlockDfaSpec<ConstLattice> = makeConstAnalysisModule();

/** Block-level fixpoint analysis for const narrowing. Owned here (at the
 *  dimension's source) so the narrowing's `blockAnalysis` thunk has a
 *  stable local binding. */
export const constAnalysis: BlockFixpointAnalysis<ConstLattice> =
  makeBlockFixpointAnalysis<ConstLattice>({
    debugName: "constAnalysis",
    direction: constAnalysisModule.direction,
    valueLattice: constAnalysisModule,
    mergeKind: constAnalysisModule.mergeKind,
    seedEnv: () => new MutableEnv<ConstLattice>(),
    transferBlock: (ctx, block, inEnv, unit) =>
      transferBlock(block, inEnv, constAnalysisModule, unit, ctx.currentContext),
    refineOnEdge: (env, edge) => constAnalysisModule.refineOnEdge(env, edge),
  });
