// Runtime-observation surface. Distinct from `Analysis<K, V>` because
// observations carry no transfer, polarity, or typed analysis read path.
//
// Dispatch: `Worklist.publish(channel, key, value, chain)` writes through
// the internal join-lattice shadow AND feeds the observation→context
// translator, which extends the owning unit's speculation context via
// registered `Narrowing`s whose `observationSource === channel`.

import { AnalysisStore } from "../framework/analysis-store";
import type { JoinSemiLattice } from "../framework/analysis";
import type { AssumptionChain } from "../assumption/chain";
import type { Worklist } from "../framework/worklist";

export class ObservationChannel<K, V> {
  /** Dedup shadow, partitioned by context. */
  private readonly shadow: AnalysisStore<K, V>;
  /** Optional registration hook, invoked by `Worklist.registerChannel`. */
  bind?: (worklist: Worklist) => void;

  /** `lattice` is used for `join`-driven dedup of observed values. */
  constructor(readonly lattice: JoinSemiLattice<V>) {
    this.shadow = new AnalysisStore<K, V>(lattice, undefined);
  }

  /** Package-private. Called only by `Worklist.publish`. */
  _writeShadow(chain: AssumptionChain, key: K, value: V): void {
    this.shadow.write(key, value, chain);
  }
}
