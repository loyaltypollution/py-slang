import type { Lattice } from "../../framework/analysis";

/** One-point liveness lattice. `true` = live; absence in `MutableEnv` = dead.
 *  Kills via `env.clear(slot)`, gens via `env.set(slot, LIVE)`. */
export type LiveVal = true;

export const LIVE: LiveVal = true;

export const livenessLattice: Lattice<LiveVal> = {
  bottom: LIVE,
  top: LIVE,
  join: (_a, _b) => LIVE,
  meet: (_a, _b) => LIVE,
  leq: (_a, _b) => true,
  eq: (_a, _b) => true,
};
