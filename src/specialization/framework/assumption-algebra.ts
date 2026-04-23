// Algebraic surface for assumption sets.
//
// An Speculation is a canonical finite partial map
// (Narrowing, Key) ⇀ Value, canonicalized by the interner and carrying
// its full binding map content-addressably (see Speculation.bindings).
//
// The structure is a bounded meet-semilattice:
//   - Order: x ⊑ y iff every binding in x is also bound to the same
//     value in y.
//   - Bottom: `empty` (no bindings).
//   - Join is partial: undefined when two sets bind the same
//     (narrowing, key) to different values. `extend` is strict on
//     conflict; the worklist retires on conflict rather than carrying
//     ⊤ through fact reads.
//
// Because each canonical chain carries its bindings map, all algebraic
// operations are O(|x|) set work, not O(depth) tree walks. The
// parent-pointer / trie shape is an implementation detail of the
// interner and is not surfaced here.

import type { Narrowing } from "./analysis";
import type { Assumption, Speculation } from "./assumption-chain";
import { ROOT_CONTEXT } from "./assumption-chain";
import { defaultInterner } from "./assumption-chain-interner";

// Re-export the carrier type so callers reading the algebra don't need a
// second import of the structural module.
export type { Speculation } from "./assumption-chain";

/** Bottom element: the empty partial map. `leq(empty, s)` for all `s`. */
export const empty: Speculation = ROOT_CONTEXT;

/** Extend `s` with a binding `(narrowing, key) ↦ value`. Idempotent when
 *  `s` already carries the same value under `narrowing.eq`. Throws when
 *  `s` already binds `(narrowing, key)` to a different value — callers
 *  that need to replace should `without(s, narrowing, key)` first. */
export function extend<K, V>(
  s: Speculation,
  narrowing: Narrowing<K, V>,
  key: K,
  value: V,
): Speculation {
  return defaultInterner.extend(s, narrowing, key, value);
}

/** Drop the binding at `(narrowing, key)` if any. Identity-returns `s`
 *  unchanged when no binding matched. */
export function without<K>(
  s: Speculation,
  narrowing: Narrowing<K, any>,
  key: K,
): Speculation {
  return defaultInterner.exclude(s, narrowing, key);
}

/** Point-query: the bound value at `(narrowing, key)`, or `undefined`.
 *  O(1) map lookup. */
export function at<K, V>(
  s: Speculation,
  narrowing: Narrowing<K, V>,
  key: K,
): V | undefined {
  const inner = s.bindings.get(narrowing as Narrowing<any, any>);
  if (inner === undefined) return undefined;
  return inner.get(key)?.value as V | undefined;
}

/** The chain node on `s`'s canonical parent-path whose tip binds
 *  `(narrowing, key)`, or `undefined` if no such binding exists. This is
 *  a trie-level concept (the node that introduced the binding in the
 *  canonical build order); the retirement machinery uses its identity as
 *  a handle on "retire the carrier of this binding." Algebraic readers
 *  should prefer `at`. */
export function carrier<K>(
  s: Speculation,
  narrowing: Narrowing<K, any>,
  key: K,
): Speculation | undefined {
  if (at(s, narrowing, key) === undefined) return undefined;
  const target = narrowing as Narrowing<unknown, unknown>;
  for (let cur: Speculation | undefined = s; cur !== undefined; cur = cur.parent) {
    const a = cur.assumption;
    if (a !== undefined && a.narrowing === target && a.key === key) return cur;
  }
  return undefined;
}

/** `leq(x, y)` iff `x ⊑ y` algebraically: every binding in `x` is also
 *  present in `y` with the same value. O(|x|). Argument order is
 *  anc-first (opposite of the prior `hasAncestor(ctx, anc)` spelling). */
export function leq(x: Speculation, y: Speculation): boolean {
  if (x === y) return true;
  if (x === ROOT_CONTEXT) return true;
  if (x.depth > y.depth) return false;
  for (const [narrowing, inner] of x.bindings) {
    const yInner = y.bindings.get(narrowing);
    if (yInner === undefined) return false;
    for (const [key, xAssumption] of inner) {
      const yAssumption = yInner.get(key);
      if (yAssumption === undefined) return false;
      // Value-equality via the narrowing's own eq, matching the interner's
      // canonicalization contract.
      if (!narrowing.eq(xAssumption.value, yAssumption.value)) return false;
    }
  }
  return true;
}

/** Iterate every binding in `s` as a frozen `Assumption`. Order is
 *  implementation-defined (outer Map iteration × inner Map iteration).
 *  Callers that need stable iteration should sort on their own. */
export function* bindings(s: Speculation): Generator<Assumption> {
  for (const inner of s.bindings.values()) {
    for (const a of inner.values()) yield a;
  }
}
