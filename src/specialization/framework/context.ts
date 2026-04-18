// A speculation context is a path of assumptions through an immutable tree.
// Root = ∅ = "assume nothing." A child extends its parent with a single
// assumption of the form "at analysis A, key K, the fact is V". Transfer
// functions running under a non-root context meet their computed fact with
// any ancestor assumption that applies to the (analysis, key) being computed.
//
// Operations on Context are navigational (parent, depth, findAssumption) —
// never lattice-valued (join, meet). Two contexts are not combined. Siblings
// represent independent speculations; a path from root to a leaf is the
// chain one compiled version depends on.

import type { Analysis } from "./analysis";

export interface Assumption<K = unknown, V = unknown> {
  readonly analysis: Analysis<K, V>;
  readonly key: K;
  readonly value: V;
}

export interface Context {
  readonly parent: Context | undefined;
  readonly assumption: Assumption | undefined;
  readonly depth: number;
}

export const ROOT_CONTEXT: Context = Object.freeze({
  parent: undefined,
  assumption: undefined,
  depth: 0,
});

export function isRoot(ctx: Context): boolean {
  return ctx.parent === undefined;
}

/** Build a child context. Returns a fresh object each call; callers that
 *  need identity-equality across sites must cache the result themselves
 *  (or go through an interner). Freezing prevents post-hoc mutation. */
export function extendContext<K, V>(
  parent: Context,
  analysis: Analysis<K, V>,
  key: K,
  value: V,
): Context {
  return Object.freeze({
    parent,
    assumption: Object.freeze({
      analysis: analysis as Analysis<unknown, unknown>,
      key: key as unknown,
      value: value as unknown,
    }),
    depth: parent.depth + 1,
  });
}

/** Walk parent pointers looking for an assumption bound against
 *  `(analysis, key)`. Returns the deepest match (closest to `ctx`).
 *  `undefined` when no ancestor carries such an assumption. */
export function findAssumption<K, V>(
  ctx: Context,
  analysis: Analysis<K, V>,
  key: K,
): V | undefined {
  const target = analysis as Analysis<unknown, unknown>;
  for (let cur: Context | undefined = ctx; cur !== undefined; cur = cur.parent) {
    const a = cur.assumption;
    if (a !== undefined && a.analysis === target && a.key === key) {
      return a.value as V;
    }
  }
  return undefined;
}

/** `anc` is an ancestor of `ctx` (or equal). O(depth). */
export function hasAncestor(ctx: Context, anc: Context): boolean {
  for (let cur: Context | undefined = ctx; cur !== undefined; cur = cur.parent) {
    if (cur === anc) return true;
  }
  return false;
}

/** Return a context derived from `ctx` with every assumption at
 *  `(analysis, key)` removed — any chain link matching the target is
 *  skipped; all other links are rebuilt in original order. Used to retract
 *  a speculation when the underlying observation widens (e.g. runtime
 *  value widens to ⊤ on conflict). Identity-returns `ctx` unchanged when
 *  no link matched — callers can short-circuit on reference equality. */
export function excludeAssumption<K, V>(
  ctx: Context,
  analysis: Analysis<K, V>,
  key: K,
): Context {
  if (ctx.parent === undefined) return ctx;
  const prunedParent = excludeAssumption(ctx.parent, analysis, key);
  const a = ctx.assumption!;
  const target = analysis as Analysis<unknown, unknown>;
  if (a.analysis === target && a.key === key) {
    return prunedParent;
  }
  if (prunedParent === ctx.parent) return ctx;
  return Object.freeze({
    parent: prunedParent,
    assumption: a,
    depth: prunedParent.depth + 1,
  });
}
