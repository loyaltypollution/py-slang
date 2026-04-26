/** AST node id. Indexes individual expression/statement nodes. */
export type NodeId = number;

/** A set of AST nodes addressed by id. The hot path needs only membership.
 *  `size` and `iterate` are optional so abstract sets (predicate-only) remain
 *  valid; `intersects(a, b)` requires at least one enumerable side. */
export interface NodeSet {
  contains(n: NodeId): boolean;
  readonly size?: number;
  iterate?(): Iterable<NodeId>;
}

/** Non-empty intersection test. Picks the cheaper iteration direction by
 *  `size`. Throws if neither side is enumerable. */
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
      contains: (n) => n === id,
      size: 1,
      iterate: () => ids,
    };
    SINGLETON_NODE_INTERNER.set(id, existing);
  }
  return existing;
}

/** A `NodeSet` view over a backing `ReadonlySet<NodeId>`. The producer must
 *  keep `ids` immutable for the lifetime of the dispatch fan-out. */
export function nodeSetOfIds(ids: ReadonlySet<NodeId>): NodeSet {
  return {
    contains: (n) => ids.has(n),
    size: ids.size,
    iterate: () => ids,
  };
}

/** Empty `NodeSet`. Useful as a no-advance delta sentinel; also serves as
 *  the empty `UnitExtent` for subscribe-time mint replay and (eventual)
 *  retirement events. */
export const EMPTY_NODESET: UnitExtent = {
  contains: () => false,
  size: 0,
  iterate: () => [],
};

/** A `NodeSet` that is finite, enumerable, and intended as an immutable
 *  snapshot for the duration of the event / consumer action that carries
 *  it. Lifecycle streams (extent change) carry `UnitExtent`, not arbitrary
 *  `NodeSet` — listeners can rely on `size` and `iterate()` without
 *  optionality, which matters for mint/rebuild/retire classification and
 *  for eviction logic.
 *
 *  Routing/subscription `NodeSet`s remain weak (predicate-only is fine).
 *  Use `UnitExtent` only where you genuinely need a snapshot. */
export interface UnitExtent extends NodeSet {
  readonly size: number;
  iterate(): Iterable<NodeId>;
}

/** Universal predicate `NodeSet` — `contains` is true for every id. Pairs
 *  only with enumerable sets; `intersects(ANY, delta)` is true iff `delta`
 *  is non-empty. Not a cell-identity subscription — use
 *  `Worklist.subscribeOnAdvance` for that. */
export const ANY_NODESET: NodeSet = {
  contains: () => true,
  size: Infinity,
  iterate: () => {
    throw new Error("[ANY_NODESET] not enumerable; pair with an enumerable delta in `intersects`.");
  },
};
