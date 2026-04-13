// Framework-level "unit CFG changed" signal. Seeded at unit construction,
// bumped by `Worklist.flushPendingRebuilds` after a transform rebuilds the
// CFG. Source pass (no derivation): readers (analyses, transforms, JIT)
// re-run on AST-shape changes and evict stale keys via their `prune` hook.

import type { Lattice, Pass, PassCtx } from "./pass";
import type { FunctionUnit } from "./function-unit";

export type AstVersion = number;

const astVersionLattice: Lattice<AstVersion> = {
  bottom: 0,
  equals: (a, b) => a === b,
  join: (a, b) => Math.max(a, b),
};

export const structuralPass: Pass<FunctionUnit, AstVersion> = {
  id: Symbol("structuralPass"),
  debugName: "structuralPass",
  lattice: astVersionLattice,
  reads: [],
  tier: "runtime",
  coarse: true,
  transfer(_ctx: PassCtx, _unit: FunctionUnit): AstVersion | undefined {
    return undefined;
  },
};
