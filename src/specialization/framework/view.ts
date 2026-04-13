import type { PassCtx } from "./pass";

/**
 * A `View` is a pure derivation over `Pass` cells. Unlike a `Pass`, a `View`
 * has no fact-store cells of its own and is not a node in the dispatch graph.
 * Consumers that want to react to a View's value must subscribe to the
 * underlying `Pass` they read through `reads`; the View is invoked inside the
 * consumer's transfer.
 *
 * Existence: a monotone, deterministic transfer over an unchanged input
 * produces an unchanged output pointwise. So if every `Pass` a View reads has
 * a closed lattice-equals gate at its source, downstream wakes through the
 * View are bounded by the source pass's wake granularity. Materializing the
 * View into a second cell would not improve that bound — it would only add
 * storage and an indirection.
 */
export interface View<K, V> {
  readonly debugName: string;
  get(ctx: PassCtx, key: K): V;
}

export function makeView<K, V>(
  debugName: string,
  compute: (ctx: PassCtx, key: K) => V,
): View<K, V> {
  return { debugName, get: compute };
}
