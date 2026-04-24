// Two-point lattice for forward-must "definitely-bound":
//   top = bound, bottom = unbound, meet = unbound wins (pessimism at joins).
//
// `MutableEnv.meetWith` treats an absent slot as top, so `analysis.ts` must
// seed every slot at entry and never `clear` during transfer.

import type { Lattice } from "../../framework/analysis";

export type BoundStatus = "bound" | "unbound";

export const BOUND: BoundStatus = "bound";
export const UNBOUND: BoundStatus = "unbound";

export const boundLattice: Lattice<BoundStatus> = {
  bottom: UNBOUND,
  top: BOUND,
  leq: (a, b) => a === UNBOUND || a === b,
  join: (a, b) => (a === BOUND || b === BOUND ? BOUND : UNBOUND),
  meet: (a, b) => (a === UNBOUND || b === UNBOUND ? UNBOUND : BOUND),
  eq: (a, b) => a === b,
};
