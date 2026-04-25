// Structural deep-clone for Stmt/Expr trees. Per-AssumptionChain variant
// bodies share fact cells with the original via preserved `nodeId`s and
// preserved prototypes (so `instanceof` keeps working). Arrays containing
// Stmt/Expr get fresh outer arrays (transforms mutate them); other arrays,
// tokens, and literal-value fields share by reference.

import { ExprNS, StmtNS } from "../../ast-types";

export function cloneStmts(stmts: readonly StmtNS.Stmt[]): StmtNS.Stmt[] {
  return stmts.map(s => cloneNode(s) as StmtNS.Stmt);
}

/** Prototype-preserving shallow copy with field overrides. */
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
