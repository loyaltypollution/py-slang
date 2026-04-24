// AssumptionChain: canonical finite partial map (Narrowing, Key) ⇀ Value,
// interned into a trie by the default interner. Algebra is in `./algebra`;
// per-chain body storage in `../speculation/assumption-bodies`.

/** Minimum interface a chain dimension needs to participate in
 *  canonicalization. Identity (object reference) keys the dimension;
 *  `eq(a, b)` collapses observationally-equal values into one binding so
 *  `(narrowing, key, value)` triples intern uniquely. The full `Narrowing`
 *  interface (lattice ops, observation source, transfer thunk) lives in
 *  framework/analysis and extends this — keeping `eq` here breaks the former
 *  type cycle between chain.ts and framework/analysis.ts.
 *
 *  Variance: K and V are covariant via the returned-tuple phantom, so a
 *  `Narrowing<NodeId, TypeLattice>` is assignable to `Narrowing<any, unknown>`. */
export interface NarrowingId<K = unknown, V = unknown> {
  eq(a: V, b: V): boolean;
  readonly __narrowingBrand?: () => readonly [K, V];
}

export interface Assumption<K = unknown, V = unknown> {
  readonly narrowing: NarrowingId<K, V>;
  readonly key: K;
  readonly value: V;
}

/** Content-addressed binding map carried by every canonical chain,
 *  nested by narrowing then key (both `===` compared). */
export type BindingsByNarrowing = ReadonlyMap<
  NarrowingId<any, any>,
  ReadonlyMap<unknown, Assumption>
>;

export interface AssumptionChain {
  readonly parent: AssumptionChain | undefined;
  readonly assumption: Assumption | undefined;
  readonly depth: number;
  readonly bindings: BindingsByNarrowing;
}

export const ROOT_CONTEXT: AssumptionChain = Object.freeze({
  parent: undefined,
  assumption: undefined,
  depth: 0,
  bindings: new Map() as BindingsByNarrowing,
});

export function isRoot(ctx: AssumptionChain): boolean {
  return ctx.parent === undefined;
}
