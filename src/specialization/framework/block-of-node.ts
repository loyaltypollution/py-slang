import { ExprNS, StmtNS } from "../../ast-types";
import type { BasicBlock, CFG } from "./cfg";

/**
 * Map every expression-node id in a CFG to its containing block. Built once
 * per CFG (re)build and consumed by `View`s that need to route a NodeId to
 * the block whose IN env determines the node's lattice value.
 *
 * Lambda single-expression bodies are walked. MultiLambda statement bodies
 * belong to a nested scope and are discovered by `ScopeDiscoveryVisitor`
 * as their own `FunctionUnit`; they are not walked here.
 */
export function buildBlockOfNode(cfg: CFG): Map<number, BasicBlock> {
  const out = new Map<number, BasicBlock>();
  for (const block of cfg.blocks) {
    for (const stmt of block.stmts) {
      for (const expr of topLevelExprs(stmt)) {
        walkExprNodes(expr, e => out.set(e.id, block));
      }
    }
  }
  return out;
}

function topLevelExprs(stmt: StmtNS.Stmt): ExprNS.Expr[] {
  if (stmt instanceof StmtNS.Assign) return exprList(stmt.target, stmt.value);
  if (stmt instanceof StmtNS.AnnAssign) return [stmt.value];
  if (stmt instanceof StmtNS.If) return [stmt.condition];
  if (stmt instanceof StmtNS.While) return [stmt.condition];
  if (stmt instanceof StmtNS.For) return [stmt.iter];
  if (stmt instanceof StmtNS.Return) return stmt.value ? [stmt.value] : [];
  if (stmt instanceof StmtNS.SimpleExpr) return [stmt.expression];
  if (stmt instanceof StmtNS.Assert) return [stmt.value];
  return [];
}

function exprList(...maybe: (ExprNS.Expr | undefined)[]): ExprNS.Expr[] {
  return maybe.filter((e): e is ExprNS.Expr => e !== undefined);
}

function walkExprNodes(expr: ExprNS.Expr, cb: (e: ExprNS.Expr) => void): void {
  cb(expr);
  if (
    expr instanceof ExprNS.Binary ||
    expr instanceof ExprNS.Compare ||
    expr instanceof ExprNS.BoolOp
  ) {
    walkExprNodes(expr.left, cb);
    walkExprNodes(expr.right, cb);
  } else if (expr instanceof ExprNS.Grouping) {
    walkExprNodes(expr.expression, cb);
  } else if (expr instanceof ExprNS.Unary) {
    walkExprNodes(expr.right, cb);
  } else if (expr instanceof ExprNS.Ternary) {
    walkExprNodes(expr.predicate, cb);
    walkExprNodes(expr.consequent, cb);
    walkExprNodes(expr.alternative, cb);
  } else if (expr instanceof ExprNS.Call) {
    walkExprNodes(expr.callee, cb);
    for (const arg of expr.args) walkExprNodes(arg, cb);
  } else if (expr instanceof ExprNS.List) {
    for (const e of expr.elements) walkExprNodes(e, cb);
  } else if (expr instanceof ExprNS.Subscript) {
    walkExprNodes(expr.value, cb);
    walkExprNodes(expr.index, cb);
  } else if (expr instanceof ExprNS.Starred) {
    walkExprNodes(expr.value, cb);
  } else if (expr instanceof ExprNS.Lambda) {
    walkExprNodes(expr.body, cb);
  }
  // Leaves: Literal, BigIntLiteral, Variable, None, Complex.
  // MultiLambda body is a nested scope — its own FunctionUnit handles it.
}
