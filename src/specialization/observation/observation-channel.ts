// Runtime-observation surface. Distinct from `Analysis<K, V>`: no
// transfer, no polarity, no chain-based fact semantics.

import type { AssumptionChain } from "../assumption/chain";
import type { JoinSemiLattice } from "../framework/analysis";
import { AnalysisStore } from "../framework/analysis-store";
import type { Worklist } from "../framework/worklist";

export class ObservationChannel<K, V> {
  /** Dedup shadow, partitioned by context. */
  private readonly shadow: AnalysisStore<K, V>;
  bind?: (worklist: Worklist) => void;

  constructor(readonly lattice: JoinSemiLattice<V>) {
    this.shadow = new AnalysisStore<K, V>(lattice, undefined);
  }

  _writeShadow(chain: AssumptionChain, key: K, value: V): void {
    this.shadow.write(key, value, chain);
  }
}
