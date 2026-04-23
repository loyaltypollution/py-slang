// Structural deep-clone for Stmt / Expr trees, used by AssumptionChain body
// forks. Preserves `id` and prototype on every node so analysis stores
// keyed by `nodeId` continue to apply.
//
// Arrays with no Stmt/Expr elements (token lists, identifier arrays,
// literal lists) are shared by reference — transforms never mutate them.
// Arrays that contain Stmt/Expr elements get a fresh outer array because
// transforms mutate them (`body.splice`, `body[i] = …`).
//
// Tokens / PyComplexNumber / literal-value fields are shared by reference.

import { ExprNS, StmtNS } from "../../ast-types";

export function cloneStmts(stmts: readonly StmtNS.Stmt[]): StmtNS.Stmt[] {
  return stmts.map(s => cloneNode(s) as StmtNS.Stmt);
}

/** Prototype-preserving shallow copy with field overrides. `instanceof`
 *  keeps working and `id` is preserved, so fact cells keyed by `nodeId`
 *  continue to apply. */
export function shadowNode<T extends object>(orig: T, patch: Partial<T>): T {
  const shadow = Object.create(Object.getPrototypeOf(orig)) as T;
  Object.assign(shadow, orig, patch);
  return shadow;
}

function cloneNode(node: object): object {
  const out = Object.create(Object.getPrototypeOf(node));
  for (const key of Object.keys(node)) {
    const v = (node as Record<string, unknown>)[key];
    (out as Record<string, unknown>)[key] = cloneValue(v);
  }
  return out;
}

function arrayHoldsTreeNodes(arr: readonly unknown[]): boolean {
  for (const el of arr) {
    if (el instanceof StmtNS.Stmt || el instanceof ExprNS.Expr) return true;
    if (Array.isArray(el) && arrayHoldsTreeNodes(el)) return true;
  }
  return false;
}

function cloneValue(v: unknown): unknown {
  if (v === null || v === undefined) return v;
  if (Array.isArray(v)) {
    return arrayHoldsTreeNodes(v) ? v.map(cloneValue) : v;
  }
  if (v instanceof StmtNS.Stmt || v instanceof ExprNS.Expr) return cloneNode(v);
  return v;
}
