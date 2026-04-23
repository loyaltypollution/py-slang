import type { Lattice } from "../framework/analysis";

/** Two-point liveness lattice. Per-slot value `true` = slot may be read
 *  before being overwritten. Absence in `MutableEnv` represents dead; we
 *  never store `false` explicitly (would confuse fixpoint convergence).
 *  Kills go through `env.clear(slot)`, gens through `env.set(slot, true)`. */
export type LiveVal = true;

export const LIVE: LiveVal = true;

export const livenessLattice: Lattice<LiveVal> = {
  // Nominal bottom for the Lattice contract; absence in an env is the real
  // operational bottom and this value is never written into an env.
  bottom: LIVE,
  top: LIVE,
  join: (_a, _b) => LIVE,
  meet: (_a, _b) => LIVE,
  leq: (_a, _b) => true,
  eq: (_a, _b) => true,
};
