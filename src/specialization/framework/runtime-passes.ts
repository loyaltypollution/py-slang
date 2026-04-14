// Runtime observation passes. Written via `Worklist.observe`; tier "runtime".

import type { Lattice, Pass, PassCtx } from "./pass";

// Saturation ceiling; post-saturation writes compare equal and suppress cascade.
export const RUNTIME_CALL_COUNT_SAT = 11;

// Right-biased: latest value wins.
const rawValueLattice: Lattice<unknown> = {
  bottom: undefined,
  equals: (a, b) => a === b,
  join: (_a, b) => b,
};

/** Runtime observation of per-node value writes. Key = NodeId, value = raw JS. */
export const runtimeWritePass: Pass<number, unknown> = {
  id: Symbol("runtimeWritePass"),
  debugName: "runtimeWritePass",
  lattice: rawValueLattice,
  reads: [],
  tier: "runtime",
  coarse: true,
  transfer(_ctx: PassCtx, _key: number): unknown {
    return undefined;
  },
};

const countLattice: Lattice<number> = {
  bottom: 0,
  equals: (a, b) => a === b,
  join: (a, b) => Math.min(RUNTIME_CALL_COUNT_SAT, Math.max(a, b)),
};

/** Runtime observation of function-entry counts. Key = FunctionDef.id. */
export const runtimeCallPass: Pass<number, number> = {
  id: Symbol("runtimeCallPass"),
  debugName: "runtimeCallPass",
  lattice: countLattice,
  reads: [],
  tier: "runtime",
  coarse: true,
  transfer(_ctx: PassCtx, _key: number): number | undefined {
    return undefined;
  },
};
