// src/specialization/memoization-analysis/call-count.ts
//
// Call-count gate for the memoization transform. `callCountPass` is a
// saturating-bucket fold of per-scope call observations, fed by
// `runtimeCallPass` writes that `Worklist.observe` dispatches on each
// recorded call. Once `CALL_COUNT_SAT` is written, equal writes suppress
// onChange, dissolving the legacy `hasNonMonotoneRule` re-fire path.

import type { Lattice, Pass, PassCtx } from "../framework/pass";
import { runtimeCallPass } from "../framework/runtime-passes";

/** Number of recorded calls after which MemoizationTransformRule may fire. */
export const MEMOIZATION_THRESHOLD = 10;

const CALL_COUNT_SAT = MEMOIZATION_THRESHOLD + 1;

const callCountLattice: Lattice<number | undefined> = {
  bottom: undefined,
  equals: (a, b) => a === b,
  join: (a, b) => {
    if (a === undefined) return b;
    if (b === undefined) return a;
    return Math.min(CALL_COUNT_SAT, Math.max(a, b));
  },
};

export const callCountPass: Pass<number, number | undefined> = {
  id: Symbol("callCountPass"),
  debugName: "callCountPass",
  lattice: callCountLattice,
  reads: [runtimeCallPass],
  tier: "analysis",
  affectedKeys(_ctx, triggerPass, triggerKey) {
    if (triggerPass === (runtimeCallPass as Pass<any, any>)) {
      return [triggerKey as number];
    }
    return [];
  },
  transfer(ctx: PassCtx, key: number): number | undefined {
    const raw = ctx.read(runtimeCallPass, key);
    return Math.min(CALL_COUNT_SAT, raw);
  },
};
