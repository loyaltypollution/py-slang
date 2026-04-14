// "Unit CFG changed" signal; bumped by `Worklist.flushPendingRebuilds`.

import type { Lattice, Pass, PassCtx } from "./pass";
import type { FunctionUnit } from "./function-unit";

export type AstVersion = number;

const astVersionLattice: Lattice<AstVersion> = {
  bottom: 0,
  leq: (a, b) => a <= b,
  join: (a, b) => Math.max(a, b),
};

export const structuralPass: Pass<FunctionUnit, AstVersion> = {
  id: Symbol("structuralPass"),
  debugName: "structuralPass",
  lattice: astVersionLattice,
  edges: [],
  tier: "runtime",
  transfer(_ctx: PassCtx, _unit: FunctionUnit): AstVersion | undefined {
    return undefined;
  },
};
