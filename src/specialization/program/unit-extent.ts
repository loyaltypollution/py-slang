// `UnitExtent` is the snapshot type lifecycle streams carry.
//
// Distinct from the routing-side `NodeSet` (which is intentionally weak —
// `size` and `iterate` are optional so predicate-only sets are valid):
// `UnitExtent` is finite, enumerable, and intended as an immutable
// snapshot for the duration of the event / consumer action that carries
// it. Listeners on `onExtentChange` can therefore rely on `size` and
// `iterate()` without optionality, which matters for mint/rebuild/retire
// classification and for eviction logic.
//
// Routing/subscription `NodeSet`s remain weak. Use `UnitExtent` only
// where you genuinely need a snapshot.

import type { NodeId, NodeSet } from "./node-set";

export interface UnitExtent extends NodeSet {
  readonly size: number;
  iterate(): Iterable<NodeId>;
}
