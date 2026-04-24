// Two-point value lattice for the forward-must "definitely-bound" analysis.
//
// The analysis asks: at this program point, is local slot `s` bound on every
// path from entry? Values are exactly "bound" or "unbound":
//
//   - "bound"   — strong claim: every path reaching here has assigned the slot.
//   - "unbound" — weak claim: at least one path has not assigned it (or has
//                 deleted it). This is the safe default and the absorbing
//                 element of the CFG-merge meet.
//
// Lattice orientation (information-theoretic):
//   top = "bound"   (maximum information; meet-identity)
//   bottom = "unbound"
//   leq: unbound ⊑ bound, bound ⊑ bound, unbound ⊑ unbound
//   meet = GLB  = "unbound wins" on disagreement (forward-must merge)
//   join = LUB  = "bound wins" on disagreement  (store-advance helper)
//
// This is the natural polarity for forward-must: at a CFG join, the merge is
// "bound" only when every predecessor carries "bound" — meet propagates
// pessimism. `MutableEnv.meetWith` treats an absent-slot side as `top` (=
// "bound"), so correctness depends on the analysis seeding every slot at
// entry and never calling `MutableEnv.clear` during transfer. See
// `analysis.ts` for the seed and transfer contracts that preserve that
// invariant.

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
