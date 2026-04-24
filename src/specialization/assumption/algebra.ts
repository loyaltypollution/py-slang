// Algebraic surface for AssumptionChains: a join-semilattice with bottom
// (ROOT_CONTEXT). `extend` is partial — throws on conflict at the same axis.

import type { Assumption, AssumptionChain, NarrowingId } from "./chain";
import { ROOT_CONTEXT } from "./chain";
import { defaultInterner } from "./interner";

export type { AssumptionChain } from "./chain";

export const empty: AssumptionChain = ROOT_CONTEXT;

export function extend<K, V>(
  s: AssumptionChain,
  narrowing: NarrowingId<K, V>,
  key: K,
  value: V,
): AssumptionChain {
  return defaultInterner.extend(s, narrowing, key, value);
}

export function without<K>(
  s: AssumptionChain,
  narrowing: NarrowingId<K, any>,
  key: K,
): AssumptionChain {
  return defaultInterner.exclude(s, narrowing, key);
}

export function at<K, V>(
  s: AssumptionChain,
  narrowing: NarrowingId<K, V>,
  key: K,
): V | undefined {
  return s.bindings.get(narrowing)?.get(key)?.value as V | undefined;
}

/** Chain node on `s`'s parent-path whose tip binds `(narrowing, key)`. */
export function carrier<K>(
  s: AssumptionChain,
  narrowing: NarrowingId<K, any>,
  key: K,
): AssumptionChain | undefined {
  if (at(s, narrowing, key) === undefined) return undefined;
  for (let cur: AssumptionChain | undefined = s; cur !== undefined; cur = cur.parent) {
    const a = cur.assumption;
    if (a !== undefined && a.narrowing === narrowing && a.key === key) return cur;
  }
  return undefined;
}

/** `x ⊑ y` iff every binding in `x` is present in `y` with the same value. */
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

export function* bindings(s: AssumptionChain): Generator<Assumption> {
  for (const inner of s.bindings.values()) yield* inner.values();
}
