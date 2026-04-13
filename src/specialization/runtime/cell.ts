import { Revision, REVISION_ZERO } from "./revision";

export type CellState = 'uninit' | 'green' | 'red' | 'computing';

export interface Cell<V> {
  value: V;
  computedAt: Revision;
  // changedAt: last revision at which `value` actually changed (Salsa verify-vs-change split).
  // Downstream staleness is decided against this, so early-cutoff re-verifies do not cascade.
  changedAt: Revision;
  deps: readonly string[];
  state: CellState;
}

export function makeCell<V>(bottom: V): Cell<V> {
  return {
    value: bottom,
    computedAt: REVISION_ZERO,
    changedAt: REVISION_ZERO,
    deps: [],
    state: 'uninit',
  };
}
