// Structural deep-clone for Stmt / Expr trees, used by the chain-body-store
// to fork an entire AST subtree when a non-ROOT chain node first gains a
// forked body. The clone preserves `id` and prototype on every node so the
// analysis store (keyed by `nodeId`) continues to apply: transforms running
// against the forked tree read/write the same fact cells they would have
// under the ancestor's tree.
//
// Why not `structuredClone`: that would strip class identity / prototype.
// Why not shallow-clone + CoW: CoW is cheaper in theory but requires every
// transform to path-clone along its mutation edge; park that until it
// measurably matters. Under the param-only narrowing policy, chain width
// per unit is small and one-shot deep cloning per fork stays affordable.
//
// Token / PyComplexNumber / literal-value fields are shared by reference —
// they are immutable value objects, transforms never mutate them.

import { ExprNS, StmtNS } from "../../ast-types";

export function cloneStmts(stmts: readonly StmtNS.Stmt[]): StmtNS.Stmt[] {
  return stmts.map(cloneStmt);
}

function cloneStmt(s: StmtNS.Stmt): StmtNS.Stmt {
  return cloneNode(s) as StmtNS.Stmt;
}

function cloneExpr(e: ExprNS.Expr): ExprNS.Expr {
  return cloneNode(e) as ExprNS.Expr;
}

function cloneNode(node: object): object {
  const out = Object.create(Object.getPrototypeOf(node));
  for (const key of Object.keys(node)) {
    const v = (node as Record<string, unknown>)[key];
    (out as Record<string, unknown>)[key] = cloneValue(v);
  }
  return out;
}

function cloneValue(v: unknown): unknown {
  if (v === null || v === undefined) return v;
  if (Array.isArray(v)) return v.map(cloneValue);
  if (v instanceof StmtNS.Stmt) return cloneStmt(v);
  if (v instanceof ExprNS.Expr) return cloneExpr(v);
  // Tokens, primitives, PyComplexNumber: shared by reference. These are
  // value-typed from the tree's perspective; mutation of them by a
  // transform would be a bug regardless of fork semantics.
  return v;
}
