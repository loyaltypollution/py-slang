// Runtime-observation surface. Distinct from `Analysis<K, V>` because
// observations carry no transfer, polarity, or typed analysis read path.
//
// Dispatch: `Worklist.publish(channel, key, value, chain)` writes through
// the internal join-lattice shadow AND feeds the observation→context
// translator, which extends the owning unit's speculation context via
// registered `Narrowing`s whose `observationSource === channel`.

import { AnalysisStore } from "./analysis-store";
import type { JoinSemiLattice } from "./analysis";
import type { AssumptionChain } from "../lattice/chain";
import type { Worklist } from "./worklist";

export interface ObservationChannelSpec<V> {
  /** Lattice over the observed value domain. `join` drives dedup. */
  readonly lattice: JoinSemiLattice<V>;
}

export class ObservationChannel<K, V> {
  readonly lattice: JoinSemiLattice<V>;
  /** Dedup shadow, partitioned by context. */
  private readonly shadow: AnalysisStore<K, V>;
  /** Optional registration hook, invoked by `Worklist.registerChannel`. */
  bind?: (worklist: Worklist) => void;

  constructor(spec: ObservationChannelSpec<V>) {
    this.lattice = spec.lattice;
    this.shadow = new AnalysisStore<K, V>(spec.lattice, undefined);
  }

  /** Package-private. Called only by `Worklist.publish`. */
  _writeShadow(chain: AssumptionChain, key: K, value: V): void {
    this.shadow.write(key, value, chain);
  }
}
