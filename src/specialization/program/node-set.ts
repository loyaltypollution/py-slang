/** AST node id. Indexes individual expression/statement nodes. */
export type NodeId = number;

/** A set of AST nodes addressed by id. The framework's hot path needs only
 *  membership; iteration is intentionally not part of the contract until a
 *  consumer demands it.
 *
 *  `size` and `iterate` are optional so abstract sets (e.g. predicate-only)
 *  remain valid `NodeSet`s. They exist so `intersects(a, b)` can pick the
 *  cheaper iteration direction. At least one side of an `intersects` test
 *  must be enumerable.
 *
 *  Owned by `program/` because "set of AST nodes" is a program-layer concept.
 *  The framework imports the type only for the `Analysis<K extends NodeSet, V>`
 *  constraint and the `delta?: NodeSet` parameter on `ctx.write` — it does
 *  not own the concept. */
export interface NodeSet {
  contains(n: NodeId): boolean;
  /** Optional: number of nodes in the set. Used by `intersects` to pick
   *  the smaller side. Producers that can compute it cheaply should expose
   *  it; callers must not rely on its presence. */
  readonly size?: number;
  /** Optional: iterate the set's members. Required when this `NodeSet` is
   *  used on either side of an `intersects` test where the other side is
   *  abstract (contains-only). */
  iterate?(): Iterable<NodeId>;
}

/** Non-empty intersection test. Picks the cheaper iteration direction by
 *  `size`; falls back to whichever side is enumerable. Throws if neither
 *  side exposes `iterate` — `intersects` cannot answer over two abstract
 *  predicate sets. */
export function intersects(a: NodeSet, b: NodeSet): boolean {
  const aIt = a.iterate;
  const bIt = b.iterate;
  if (aIt !== undefined && bIt !== undefined) {
    const aSize = a.size ?? Infinity;
    const bSize = b.size ?? Infinity;
    if (aSize <= bSize) {
      for (const n of aIt.call(a)) if (b.contains(n)) return true;
    } else {
      for (const n of bIt.call(b)) if (a.contains(n)) return true;
    }
    return false;
  }
  if (aIt !== undefined) {
    for (const n of aIt.call(a)) if (b.contains(n)) return true;
    return false;
  }
  if (bIt !== undefined) {
    for (const n of bIt.call(b)) if (a.contains(n)) return true;
    return false;
  }
  throw new Error("[intersects] neither NodeSet is enumerable; at least one must expose `iterate`.");
}

/** Wrap a `NodeId` as a singleton `NodeSet`. Interned: repeated calls with
 *  the same id return the same object so reference equality is valid for
 *  dispatch-index keys. */
const SINGLETON_NODE_INTERNER = new Map<NodeId, NodeSet>();
export function internSingletonNode(id: NodeId): NodeSet {
  let existing = SINGLETON_NODE_INTERNER.get(id);
  if (existing === undefined) {
    const ids: readonly NodeId[] = [id];
    existing = {
      contains: (n: NodeId) => n === id,
      size: 1,
      iterate: () => ids,
    };
    SINGLETON_NODE_INTERNER.set(id, existing);
  }
  return existing;
}

/** A `NodeSet` view over a backing `ReadonlySet<NodeId>`. The producer is
 *  expected to keep `ids` immutable for the lifetime of the dispatch fan-out;
 *  no defensive copy is taken. */
export function nodeSetOfIds(ids: ReadonlySet<NodeId>): NodeSet {
  return {
    contains: (n: NodeId) => ids.has(n),
    size: ids.size,
    iterate: () => ids,
  };
}

/** Empty `NodeSet`. Useful as a no-advance delta sentinel. */
export const EMPTY_NODESET: NodeSet = {
  contains: () => false,
  size: 0,
  iterate: () => [],
};

/** Universal predicate `NodeSet` — `contains` is true for every id. This is
 *  not a cell-identity subscription; use `Worklist.subscribeOnAdvance` when a
 *  listener must fire on every advancing write regardless of node delta. Pairs
 *  only with enumerable sets; `intersects(ANY, delta)` is true iff `delta` is
 *  non-empty. */
export const ANY_NODESET: NodeSet = {
  contains: () => true,
  size: Infinity,
  iterate: () => {
    throw new Error("[ANY_NODESET] not enumerable; pair with an enumerable delta in `intersects`.");
  },
};
