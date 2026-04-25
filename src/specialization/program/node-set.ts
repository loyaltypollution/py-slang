/** AST node id. Indexes individual expression/statement nodes. */
export type NodeId = number;

/** A set of AST nodes addressed by id. The framework's hot path needs only
 *  membership; iteration is intentionally not part of the contract until a
 *  consumer demands it.
 *
 *  Owned by `program/` because "set of AST nodes" is a program-layer concept.
 *  The framework imports the type only for the `Analysis<K extends NodeSet, V>`
 *  constraint and the `delta?: NodeSet` parameter on `ctx.write` — it does
 *  not own the concept. */
export interface NodeSet {
  contains(n: NodeId): boolean;
}

/** Wrap a `NodeId` as a singleton `NodeSet`. Interned: repeated calls with
 *  the same id return the same object so reference equality is valid for
 *  dispatch-index keys. */
const SINGLETON_NODE_INTERNER = new Map<NodeId, NodeSet>();
export function internSingletonNode(id: NodeId): NodeSet {
  let existing = SINGLETON_NODE_INTERNER.get(id);
  if (existing === undefined) {
    existing = { contains: (n: NodeId) => n === id };
    SINGLETON_NODE_INTERNER.set(id, existing);
  }
  return existing;
}

/** A `NodeSet` view over a backing `ReadonlySet<NodeId>`. The producer is
 *  expected to keep `ids` immutable for the lifetime of the dispatch fan-out;
 *  no defensive copy is taken. */
export function nodeSetOfIds(ids: ReadonlySet<NodeId>): NodeSet {
  return { contains: (n: NodeId) => ids.has(n) };
}

/** Empty `NodeSet`. Useful as a no-advance delta sentinel. */
export const EMPTY_NODESET: NodeSet = { contains: () => false };
