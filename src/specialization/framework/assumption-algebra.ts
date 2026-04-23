// Algebraic surface for Speculation sets. A Speculation is a canonical
// finite partial map (Narrowing, Key) ⇀ Value, interned content-addressably.
// The structure is a bounded meet-semilattice; join is partial and extend
// throws on conflict.

import type { Narrowing } from "./analysis";
import type { Assumption, Speculation } from "./assumption-chain";
import { ROOT_CONTEXT } from "./assumption-chain";
import { defaultInterner } from "./assumption-chain-interner";

export type { Speculation } from "./assumption-chain";

/** Bottom element: the empty partial map. */
export const empty: Speculation = ROOT_CONTEXT;

/** Extend `s` with `(narrowing, key) ↦ value`. Idempotent on equal value;
 *  throws on conflict — callers replacing a value should `without` first. */
export function extend<K, V>(
  s: Speculation,
  narrowing: Narrowing<K, V>,
  key: K,
  value: V,
): Speculation {
  return defaultInterner.extend(s, narrowing, key, value);
}

/** Drop the binding at `(narrowing, key)`, or identity-return if absent. */
export function without<K>(
  s: Speculation,
  narrowing: Narrowing<K, any>,
  key: K,
): Speculation {
  return defaultInterner.exclude(s, narrowing, key);
}

/** Bound value at `(narrowing, key)`, or `undefined`. O(1). */
export function at<K, V>(
  s: Speculation,
  narrowing: Narrowing<K, V>,
  key: K,
): V | undefined {
  return s.bindings.get(narrowing)?.get(key)?.value as V | undefined;
}

/** Chain node on `s`'s canonical parent-path whose tip binds
 *  `(narrowing, key)`. Trie-level concept used as a retirement handle. */
export function carrier<K>(
  s: Speculation,
  narrowing: Narrowing<K, any>,
  key: K,
): Speculation | undefined {
  if (at(s, narrowing, key) === undefined) return undefined;
  for (let cur: Speculation | undefined = s; cur !== undefined; cur = cur.parent) {
    const a = cur.assumption;
    if (a !== undefined && a.narrowing === narrowing && a.key === key) return cur;
  }
  return undefined;
}

/** `x ⊑ y` iff every binding in `x` is present in `y` with the same
 *  value under the narrowing's `eq`. O(|x|). */
export function leq(x: Speculation, y: Speculation): boolean {
  if (x === y) return true;
  if (x.depth > y.depth) return false;
  for (const [narrowing, inner] of x.bindings) {
    const yInner = y.bindings.get(narrowing);
    if (yInner === undefined) return false;
    for (const [key, xAssumption] of inner) {
      const yAssumption = yInner.get(key);
      if (yAssumption === undefined) return false;
      if (!narrowing.eq(xAssumption.value, yAssumption.value)) return false;
    }
  }
  return true;
}

/** Iterate every binding in `s`. Order is implementation-defined. */
export function* bindings(s: Speculation): Generator<Assumption> {
  for (const inner of s.bindings.values()) {
    for (const a of inner.values()) yield a;
  }
}
