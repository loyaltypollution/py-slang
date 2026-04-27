import { ExprNS } from "../../../ast-types";
import { TokenType } from "../../../tokenizer";
import { blockFixpointFromSpec } from "../../analysis/stmt-transfer";
import type { AssumptionChain } from "../../assumption/chain";
import { type NodeId } from "../../framework/analysis";
import { isLocal, type SlotLookup } from "../../program/function/slot-table";
import { MutableEnv } from "../block-env";
import type {
  BlockDfaSpec,
  BlockFixpointAnalysis,
} from "../dfa-factory";
import {
  CONST_TOP,
  constLattice,
  constOf,
  type ConstLattice
} from "./lattice";

function foldBinary(op: TokenType, left: ConstLattice, right: ConstLattice): ConstLattice {
  if (left.tag !== "const" || right.tag !== "const") return CONST_TOP;
  const lv = left.value;
  const rv = right.value;
  switch (op) {
    case TokenType.PLUS:
      return constOf(lv + rv);
    case TokenType.MINUS:
      return constOf(lv - rv);
    case TokenType.STAR:
      return constOf(lv * rv);
    case TokenType.SLASH:
      return rv === 0 ? CONST_TOP : constOf(lv / rv);
    case TokenType.DOUBLESLASH:
      return rv === 0 ? CONST_TOP : constOf(Math.floor(lv / rv));
    case TokenType.PERCENT:
      // Python modulo: result has same sign as divisor.
      return rv === 0 ? CONST_TOP : constOf(lv - Math.floor(lv / rv) * rv);
    default:
      return CONST_TOP;
  }
}

function foldUnary(op: TokenType, operand: ConstLattice): ConstLattice {
  if (operand.tag !== "const") return CONST_TOP;
  switch (op) {
    case TokenType.MINUS:
      return constOf(-operand.value);
    case TokenType.PLUS:
      return constOf(+operand.value);
    default:
      return CONST_TOP;
  }
}

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

  /** Recurse into children for fact recording, yield TOP. */
  private visitChildrenAsTop(node: ExprNS.Expr, children: ExprNS.Expr[]): ConstLattice {
    for (const child of children) child.accept(this);
    return this.annotate(node, CONST_TOP);
  }

  visitLiteralExpr(expr: ExprNS.Literal): ConstLattice {
    const val = typeof expr.value === "number" ? constOf(expr.value) : CONST_TOP;
    return this.annotate(expr, val);
  }

  visitBigIntLiteralExpr(expr: ExprNS.BigIntLiteral): ConstLattice {
    return this.annotate(expr, constOf(Number(expr.value)));
  }

  visitVariableExpr(expr: ExprNS.Variable): ConstLattice {
    const info = this.slotLookup(expr.name);
    const val = isLocal(info) ? this.constEnv.get(info.slot) ?? CONST_TOP : CONST_TOP;
    return this.annotate(expr, val);
  }

  visitBinaryExpr(expr: ExprNS.Binary): ConstLattice {
    const left = expr.left.accept(this);
    const right = expr.right.accept(this);
    return this.annotate(expr, foldBinary(expr.operator.type, left, right));
  }

  visitUnaryExpr(expr: ExprNS.Unary): ConstLattice {
    const operand = expr.right.accept(this);
    return this.annotate(expr, foldUnary(expr.operator.type, operand));
  }

  visitGroupingExpr(expr: ExprNS.Grouping): ConstLattice {
    return this.annotate(expr, expr.expression.accept(this));
  }

  // Compare/BoolOp boolean reasoning lives in TypeAnalysis (BoolRef), not here.
  visitCompareExpr(expr: ExprNS.Compare): ConstLattice {
    return this.visitChildrenAsTop(expr, [expr.left, expr.right]);
  }

  visitBoolOpExpr(expr: ExprNS.BoolOp): ConstLattice {
    return this.visitChildrenAsTop(expr, [expr.left, expr.right]);
  }

  visitTernaryExpr(expr: ExprNS.Ternary): ConstLattice {
    return this.visitChildrenAsTop(expr, [expr.predicate, expr.consequent, expr.alternative]);
  }

  visitCallExpr(expr: ExprNS.Call): ConstLattice {
    return this.visitChildrenAsTop(expr, [expr.callee, ...expr.args]);
  }

  visitListExpr(expr: ExprNS.List): ConstLattice {
    return this.visitChildrenAsTop(expr, expr.elements);
  }

  visitSubscriptExpr(expr: ExprNS.Subscript): ConstLattice {
    return this.visitChildrenAsTop(expr, [expr.value, expr.index]);
  }

  visitStarredExpr(expr: ExprNS.Starred): ConstLattice {
    return this.visitChildrenAsTop(expr, [expr.value]);
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

const constAnalysisModule: BlockDfaSpec<ConstLattice> = {
  ...constLattice,
  mergeKind: "may",
  direction: "forward",
  makeExprVisitor(
    env: MutableEnv<ConstLattice>,
    _unit,
    slotLookup: SlotLookup,
    recordExprFact: (nodeId: NodeId, val: ConstLattice) => void,
    _context: AssumptionChain,
  ): ExprNS.Visitor<ConstLattice> {
    return new ConstAnalysisVisitor(env, slotLookup, recordExprFact);
  },
};

export const constAnalysis: BlockFixpointAnalysis<ConstLattice> =
  blockFixpointFromSpec(constAnalysisModule);
