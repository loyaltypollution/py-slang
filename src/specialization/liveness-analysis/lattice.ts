import type { Lattice } from "../framework/analysis";

/** Trivial two-point liveness lattice.
 *
 *  Per-slot value: `true` = slot may be read on some path from here before
 *  it is overwritten. Absence in `MutableEnv` (i.e. `env.get(slot) ===
 *  undefined`) represents dead. We never store `false` explicitly — the env's
 *  `leq` treats missing vs present asymmetrically, and storing an explicit
 *  bottom would confuse fixpoint convergence.
 *
 *  Kills go through `env.clear(slot)`. Gens go through `env.set(slot, true)`.
 */
export type LiveVal = true;

export const LIVE: LiveVal = true;

export const livenessLattice: Lattice<LiveVal> = {
  // Nominal bottom for the Lattice contract. Absence in an env is the
  // real operational bottom; this value is never written into an env.
  bottom: LIVE,
  top: LIVE,
  join: (_a, _b) => LIVE,
  meet: (_a, _b) => LIVE,
  leq: (_a, _b) => true,
  eq: (_a, _b) => true,
};
