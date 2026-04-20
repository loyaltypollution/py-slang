// A speculation context is a path of assumptions through an immutable tree.
// Root = ∅ = "assume nothing." A child extends its parent with a single
// assumption of the form "for narrowing N, key K, the assumed value is V".
// Transfer functions running under a non-root context meet their computed fact
// with any ancestor assumption that applies to the (narrowing, key) being
// computed.
//
// Operations on AssumptionChain are navigational (parent, depth, findAssumption) —
// never lattice-valued (join, meet). Two chains are not combined. Siblings
// represent independent speculations; a path from root to a leaf is the
// chain one compiled version depends on.
//
// Chains are canonicalized and interned: `extendContext` / `excludeAssumption`
// return a canonical AssumptionChain keyed by the assumption *set*. Two call paths
// that converge on the same set produce `===` references, so every AssumptionChain-
// keyed structure downstream (per-analysis stores, JIT cache, worklist
// pending set) de-fragments automatically. Canonical order is
// `(narrowing.debugName, key)` ascending; the interner lives in
// `./context-interner.ts`.

import type { AssumptionHandle } from "./analysis";
import { defaultInterner } from "./context-interner";

export interface Assumption<K = unknown, V = unknown> {
  readonly narrowing: AssumptionHandle<K, V>;
  readonly key: K;
  readonly value: V;
}

export interface AssumptionChain {
  readonly parent: AssumptionChain | undefined;
  readonly assumption: Assumption | undefined;
  readonly depth: number;
}

export const ROOT_CONTEXT: AssumptionChain = Object.freeze({
  parent: undefined,
  assumption: undefined,
  depth: 0,
});

export function isRoot(ctx: AssumptionChain): boolean {
  return ctx.parent === undefined;
}

/** Build a canonical child context. Equivalent calls (same `parent`, same
 *  `(narrowing, key)`, and algebra-equal value) return the same object —
 *  identity is a sound proxy for structural equality. Value dedup uses the
 *  narrowing's value-equality relation, so no per-caller equality parameter
 *  is needed.
 *
 *  Chains are stored in canonical order by `(narrowing.debugName, key)`, so
 *  adding an assumption that sorts before an existing link triggers a
 *  silent rebuild — the returned chain may not have `parent` as its literal
 *  `.parent` pointer when the sort order requires insertion mid-chain. */
export function extendContext<K, V>(
  parent: AssumptionChain,
  narrowing: AssumptionHandle<K, V>,
  key: K,
  value: V,
): AssumptionChain {
  return defaultInterner.extend(parent, narrowing, key, value);
}

/** Walk parent pointers looking for an assumption bound against
 *  `(narrowing, key)`. Returns the deepest match (closest to `ctx`).
 *  `undefined` when no ancestor carries such an assumption. */
export function findAssumption<K, V>(
  ctx: AssumptionChain,
  narrowing: AssumptionHandle<K, V>,
  key: K,
): V | undefined {
  const target = narrowing as AssumptionHandle<unknown, unknown>;
  for (let cur: AssumptionChain | undefined = ctx; cur !== undefined; cur = cur.parent) {
    const a = cur.assumption;
    if (a !== undefined && a.narrowing === target && a.key === key) {
      return a.value as V;
    }
  }
  return undefined;
}

/** `anc` is an ancestor of `ctx` (or equal). O(depth). */
export function hasAncestor(ctx: AssumptionChain, anc: AssumptionChain): boolean {
  for (let cur: AssumptionChain | undefined = ctx; cur !== undefined; cur = cur.parent) {
    if (cur === anc) return true;
  }
  return false;
}

/** Return a context derived from `ctx` with every assumption at
 *  `(narrowing, key)` removed. Identity-returns `ctx` unchanged when no
 *  link matched — callers can short-circuit on reference equality. The
 *  canonical invariant guarantees at most one match (collisions at the
 *  same `(narrowing, key)` are replaced at extend-time, not layered), so
 *  "every" is 0 or 1 in practice — the wording is preserved for the
 *  historical contract. The returned chain is canonical; a prune that
 *  leaves a subset any prior compilation was built under returns the `===`
 *  pre-built sibling. */
export function excludeAssumption<K, V>(
  ctx: AssumptionChain,
  narrowing: AssumptionHandle<K, V>,
  key: K,
): AssumptionChain {
  return defaultInterner.exclude(ctx, narrowing, key);
}
