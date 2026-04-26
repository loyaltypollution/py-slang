import type { JoinSemiLattice } from "../framework/analysis";
import type { Worklist } from "../framework/worklist";

export class ObservationChannel<K, V> {
  bind?: (worklist: Worklist<any, any>) => void;

  constructor(
    readonly lattice: JoinSemiLattice<V>,
    readonly isUnknown: (value: V) => boolean,
  ) {}
}
