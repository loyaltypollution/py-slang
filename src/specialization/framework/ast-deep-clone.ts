// Structural deep-clone for Stmt / Expr trees, used by Speculation body forks
// to fork an entire AST subtree when a non-ROOT chain node first gains a
// forked body. The clone preserves `id` and prototype on every node so the
// analysis store (keyed by `nodeId`) continues to apply: transforms running
// against the forked tree read/write the same fact cells they would have
// under the ancestor's tree.
//
// Why not `structuredClone`: that would strip class identity / prototype.
//
// Why not full CoW: the transform contract says `body = chain.forkBody(unit)`
// returns a freely-mutable tree, and rules mutate at arbitrary depth (nested
// If bodies, expression operands). A proxy-based CoW would either trap every
// read on the hot path or rely on transforms to path-clone themselves — both
// invasive. Park full CoW until a transform-level refactor makes write sites
// explicit.
//
// What this module does instead, to keep per-fork cost proportional to tree
// size and not to incidental array churn:
//
//   1. Arrays with no Stmt/Expr elements (token lists, identifier arrays,
//      literal lists) are shared by reference. Transforms never mutate these
//      — they are value-typed from the tree's perspective — so the defensive
//      `array.map` that the previous implementation used was pure waste.
//
//   2. Arrays that DO contain Stmt/Expr elements always get a fresh outer
//      array, because transforms mutate `body.splice`, `body[i] = …`, etc.
//
// Token / PyComplexNumber / literal-value fields are shared by reference —
// they are immutable value objects, transforms never mutate them.

import { ExprNS, StmtNS } from "../../ast-types";

export function cloneStmts(stmts: readonly StmtNS.Stmt[]): StmtNS.Stmt[] {
  return stmts.map(s => cloneNode(s) as StmtNS.Stmt);
}

/** Prototype-preserving shallow copy with field overrides. `instanceof` keeps
 *  working (preserved prototype) and `id` is preserved via `Object.assign`, so
 *  fact cells keyed by `nodeId` continue to apply. Use when a transform wants
 *  to produce a tweaked variant of a node without disturbing the original. */
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
    // Share by reference when the array carries no tree nodes — tokens,
    // identifiers, literal lists are never mutated by a transform. The
    // previous implementation always allocated a fresh array here, which
    // compounded over every node of every forked body.
    return arrayHoldsTreeNodes(v) ? v.map(cloneValue) : v;
  }
  if (v instanceof StmtNS.Stmt || v instanceof ExprNS.Expr) return cloneNode(v);
  // Tokens, primitives, PyComplexNumber: shared by reference. These are
  // value-typed from the tree's perspective; mutation of them by a
  // transform would be a bug regardless of fork semantics.
  return v;
}
