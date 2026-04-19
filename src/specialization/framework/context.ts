// A speculation context is a path of assumptions through an immutable tree.
// Root = ∅ = "assume nothing." A child extends its parent with a single
// assumption of the form "for handle/analysis A, key K, the assumed value is V".
// Transfer functions running under a non-root context meet their computed fact
// with any ancestor assumption that applies to the (analysis, key) being
// computed.
//
// Operations on Context are navigational (parent, depth, findAssumption) —
// never lattice-valued (join, meet). Two contexts are not combined. Siblings
// represent independent speculations; a path from root to a leaf is the
// chain one compiled version depends on. In today's codebase the `analysis`
// field on an assumption is often a narrowing handle rather than a scheduled
// fixpoint analysis; the shared `Analysis<K, V>` shape is structural reuse,
// not proof that both citizen kinds play the same role.
//
// Chains are canonicalized and interned: `extendContext` / `excludeAssumption`
// return a canonical Context keyed by the assumption *set*. Two call paths
// that converge on the same set produce `===` references, so every Context-
// keyed structure downstream (per-analysis stores, JIT cache, worklist
// pending set) de-fragments automatically. Canonical order is
// `(analysis.debugName, key)` ascending; the interner lives in
// `./context-interner.ts`.

import type { AssumptionHandle } from "./analysis";
import { defaultInterner } from "./context-interner";

export interface Assumption<K = unknown, V = unknown> {
  readonly analysis: AssumptionHandle<K, V>;
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

/** Build a canonical child context. Equivalent calls (same `parent`, same
 *  `(analysis, key)`, and algebra-equal value) return the same object —
 *  identity is a sound proxy for structural equality. Value dedup uses the
 *  handle/analysis value algebra, so no per-caller equality parameter is
 *  needed.
 *
 *  Chains are stored in canonical order by `(analysis.debugName, key)`, so
 *  adding an assumption that sorts before an existing link triggers a
 *  silent rebuild — the returned chain may not have `parent` as its literal
 *  `.parent` pointer when the sort order requires insertion mid-chain. */
export function extendContext<K, V>(
  parent: Context,
  analysis: AssumptionHandle<K, V>,
  key: K,
  value: V,
): Context {
  return defaultInterner.extend(parent, analysis, key, value);
}

/** Walk parent pointers looking for an assumption bound against
 *  `(analysis, key)`. Returns the deepest match (closest to `ctx`).
 *  `undefined` when no ancestor carries such an assumption. */
export function findAssumption<K, V>(
  ctx: Context,
  analysis: AssumptionHandle<K, V>,
  key: K,
): V | undefined {
  const target = analysis as AssumptionHandle<unknown, unknown>;
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
 *  `(analysis, key)` removed. Identity-returns `ctx` unchanged when no link
 *  matched — callers can short-circuit on reference equality. The canonical
 *  invariant guarantees at most one match (collisions at the same
 *  `(analysis, key)` are replaced at extend-time, not layered), so "every"
 *  is 0 or 1 in practice — the wording is preserved for the historical
 *  contract. The returned chain is canonical; a prune that leaves a subset
 *  any prior compilation was built under returns the `===` pre-built sibling. */
export function excludeAssumption<K, V>(
  ctx: Context,
  analysis: AssumptionHandle<K, V>,
  key: K,
): Context {
  return defaultInterner.exclude(ctx, analysis, key);
}
