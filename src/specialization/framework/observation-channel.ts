// Runtime-observation surface. Distinct from `Analysis<K, V>` because
// observations are not semantic fixpoint facts — they carry no transfer, no
// polarity, and no typed read path through the analysis read surface.
// The channel's only public reads are its own identity fields (used by
// narrowings as `observationSource`) and a dedup probe
// (`tryReadAt`) that the observer adapter uses to short-circuit when a cell
// has already saturated to ⊤.
//
// Dispatch: `Worklist.publish(channel, key, value, chain)` writes through
// the internal join-lattice shadow AND feeds the observation→context
// translator, which extends the owning unit's speculation context via
// registered `Narrowing`s whose `observationSource === channel`. Store
// writes are a private implementation detail of dedup; nothing outside the
// channel reads them as semantic facts.

import { AnalysisStore } from "./analysis-store";
import type { JoinSemiLattice } from "./analysis";
import type { AssumptionChain } from "./assumption-chain";
import type { Worklist } from "./worklist";

export interface ObservationChannelSpec<K, V> {
  /** Lattice over the observed value domain. `join` drives dedup: repeated
   *  observations at the same (chain, key) collapse toward ⊤. Used
   *  internally by the channel's shadow store. */
  readonly lattice: JoinSemiLattice<V>;
  /** Optional registration hook. Called by `Worklist.registerChannel`.
   *  Typical use: wire `onRetireEvict` to drop cells for retiring units.
   *  Mirrors `Analysis.bind` / `CounterStore.bind`. */
  bind?(this: ObservationChannel<K, V>, worklist: Worklist): void;
}

export class ObservationChannel<K, V> {
  readonly lattice: JoinSemiLattice<V>;
  /** Internal dedup shadow. Contexts partition the shadow the same way
   *  `AnalysisStore` partitions analysis facts — two identical observations
   *  under different specialization chains do not dedup against each other. */
  private readonly shadow: AnalysisStore<K, V>;
  readonly bind?: (worklist: Worklist) => void;

  constructor(spec: ObservationChannelSpec<K, V>) {
    this.lattice = spec.lattice;
    this.shadow = new AnalysisStore<K, V>(spec.lattice, undefined);
    if (spec.bind !== undefined) this.bind = spec.bind.bind(this);
  }

  /** Read the dedup shadow at `chain`. The observer adapter uses this to
   *  short-circuit when a prior observation has already saturated the cell.
   *  Not a semantic fact — consumers that need a semantic read should
   *  subscribe a narrowing, not poke at this surface. */
  tryReadAt(chain: AssumptionChain, key: K): V | undefined {
    return this.shadow.tryRead(key, chain);
  }

  /** Equality relation on observed values. Used by narrowings that borrow
   *  the channel's lattice-equality. */
  eq(a: V, b: V): boolean {
    return this.lattice.eq(a, b);
  }

  /** Drop every cell for `key` across all chains. Eviction hook wiring. */
  evictKeyAcrossChains(key: K): void {
    for (const ctx of this.shadow.contexts()) this.shadow.evict(key, ctx);
  }

  /** Package-private. Called only by `Worklist.publish`. Joins `value`
   *  into the shadow at `chain`. */
  _writeShadow(chain: AssumptionChain, key: K, value: V): void {
    this.shadow.write(key, value, chain);
  }
}

export function defineObservationChannel<K, V>(
  spec: ObservationChannelSpec<K, V>,
): ObservationChannel<K, V> {
  return new ObservationChannel<K, V>(spec);
}
