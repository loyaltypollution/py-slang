// Call-count gate for memoization. Saturating fold over `runtimeCallPass`
// writes dispatched by `Worklist.observe`. Saturates at CALL_COUNT_SAT so
// equal writes suppress onChange once the threshold is cleared.

import type { Lattice, Pass, PassCtx } from "../framework/pass";
import { runtimeCallPass } from "../framework/runtime-passes";

/** Number of recorded calls after which MemoizationTransformRule may fire. */
export const MEMOIZATION_THRESHOLD = 10;

const CALL_COUNT_SAT = MEMOIZATION_THRESHOLD + 1;

const callCountLattice: Lattice<number> = {
  bottom: 0,
  equals: (a, b) => a === b,
  join: (a, b) => Math.min(CALL_COUNT_SAT, Math.max(a, b)),
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
    return Math.min(CALL_COUNT_SAT, raw);
  },
};
