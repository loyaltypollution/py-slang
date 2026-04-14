// Call-count gate for memoization; saturating fold over runtimeCallPass writes.

import type { Lattice, Pass, PassCtx } from "../framework/pass";
import { runtimeCallPass, RUNTIME_CALL_COUNT_SAT } from "../framework/runtime-passes";

/** Calls required before MemoizationTransformRule may fire; derived from the runtime saturation ceiling so they cannot drift. */
export const MEMOIZATION_THRESHOLD = RUNTIME_CALL_COUNT_SAT - 1;

const callCountLattice: Lattice<number> = {
  bottom: 0,
  equals: (a, b) => a === b,
  join: (a, b) => Math.min(RUNTIME_CALL_COUNT_SAT, Math.max(a, b)),
};

export const callCountPass: Pass<number, number> = {
  id: Symbol("callCountPass"),
  debugName: "callCountPass",
  lattice: callCountLattice,
  reads: [runtimeCallPass],
  tier: "analysis",
  affectedKeys: (_ctx, _triggerPass, triggerKey) => [triggerKey as number],
  transfer(ctx: PassCtx, key: number): number | undefined {
    const raw = ctx.read(runtimeCallPass, key);
    return Math.min(RUNTIME_CALL_COUNT_SAT, raw);
  },
};
