// Algebraic surface for AssumptionChains. An AssumptionChain is a canonical
// finite partial map (Narrowing, Key) ⇀ Value, interned content-addressably.
// The structure is a join-semilattice with bottom (the empty chain); join
// is partial — `extend` throws on conflicting bindings at the same axis.

import type { Narrowing } from "../framework/analysis";
import type { Assumption, AssumptionChain } from "./chain";
import { ROOT_CONTEXT } from "./chain";
import { defaultInterner } from "./interner";

export type { AssumptionChain } from "./chain";

/** Bottom element: the empty partial map. Alias for `ROOT_CONTEXT`. */
export const empty: AssumptionChain = ROOT_CONTEXT;

/** Extend `s` with `(narrowing, key) ↦ value`. Idempotent on equal value;
 *  throws on conflict — callers replacing a value should `without` first. */
export function extend<K, V>(
  s: AssumptionChain,
  narrowing: Narrowing<K, V>,
  key: K,
  value: V,
): AssumptionChain {
  return defaultInterner.extend(s, narrowing, key, value);
}

/** Drop the binding at `(narrowing, key)`, or identity-return if absent. */
export function without<K>(
  s: AssumptionChain,
  narrowing: Narrowing<K, any>,
  key: K,
): AssumptionChain {
  return defaultInterner.exclude(s, narrowing, key);
}

/** Bound value at `(narrowing, key)`, or `undefined`. O(1). */
export function at<K, V>(
  s: AssumptionChain,
  narrowing: Narrowing<K, V>,
  key: K,
): V | undefined {
  return s.bindings.get(narrowing)?.get(key)?.value as V | undefined;
}

/** Chain node on `s`'s canonical parent-path whose tip binds
 *  `(narrowing, key)`. Trie-level concept used as a retirement handle. */
export function carrier<K>(
  s: AssumptionChain,
  narrowing: Narrowing<K, any>,
  key: K,
): AssumptionChain | undefined {
  if (at(s, narrowing, key) === undefined) return undefined;
  for (let cur: AssumptionChain | undefined = s; cur !== undefined; cur = cur.parent) {
    const a = cur.assumption;
    if (a !== undefined && a.narrowing === narrowing && a.key === key) return cur;
  }
  return undefined;
}

/** `x ⊑ y` iff every binding in `x` is present in `y` with the same
 *  value under the narrowing's `eq`. O(|x|). */
export function leq(x: AssumptionChain, y: AssumptionChain): boolean {
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
export function* bindings(s: AssumptionChain): Generator<Assumption> {
  for (const inner of s.bindings.values()) {
    for (const a of inner.values()) yield a;
  }
}
