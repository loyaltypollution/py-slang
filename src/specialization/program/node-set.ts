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
  // Pick the side to iterate: prefer the smaller enumerable side.
  const aSize = a.iterate !== undefined ? (a.size ?? Infinity) : Infinity;
  const bSize = b.iterate !== undefined ? (b.size ?? Infinity) : Infinity;
  if (aSize === Infinity && bSize === Infinity) {
    throw new Error("[intersects] neither NodeSet is enumerable; at least one must expose `iterate`.");
  }
  const [iter, probe] = aSize <= bSize ? [a, b] : [b, a];
  for (const n of iter.iterate!()) if (probe.contains(n)) return true;
  return false;
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
 *  the empty `FunctionExtent` for subscribe-time mint replay and (eventual)
 *  retirement events. `FunctionExtent` lives in `./unit-extent.ts`. */
import type { FunctionExtent } from "./unit-extent";
export const EMPTY_NODESET: FunctionExtent = {
  contains: () => false,
  size: 0,
  iterate: () => [],
};
