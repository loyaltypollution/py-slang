// Runtime-observation surface. Distinct from `Analysis<K, V>`: no
// transfer, no polarity, no chain-based fact semantics. The channel is an
// identity token: `bindingsBySource` keys by reference, and `publish`
// fans out to every binding registered on that token.
//
// `isUnknown(v)` is the lattice-top predicate the worklist consults to
// decide whether an observation is "no information" (triggers refutation
// of prior narrowings) or a concrete refinement. Keeping it on the channel
// instead of inspecting the value-shape in the framework is what decouples
// `Worklist` from any backend's specific observation taxonomy.

import type { JoinSemiLattice } from "../framework/analysis";
import type { Worklist } from "../framework/worklist";

export class ObservationChannel<K, V> {
  bind?: (worklist: Worklist) => void;

  constructor(
    readonly lattice: JoinSemiLattice<V>,
    readonly isUnknown: (value: V) => boolean,
  ) {}
}
