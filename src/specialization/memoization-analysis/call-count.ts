// Call-count gate for memoization; saturating fold over runtimeCallPass writes.

import type { Pass, PassCtx } from "../framework/pass";
import { runtimeCallPass, RUNTIME_CALL_COUNT_SAT, saturatingCountLattice } from "../framework/runtime-passes";

/** Calls required before MemoizationTransformRule may fire; derived from the runtime saturation ceiling so they cannot drift. */
export const MEMOIZATION_THRESHOLD = RUNTIME_CALL_COUNT_SAT - 1;

export const callCountPass: Pass<number, number> = {
  id: Symbol("callCountPass"),
  debugName: "callCountPass",
  lattice: saturatingCountLattice,
  edges: [
    { on: "fact", pass: runtimeCallPass, wake: (_ctx, key) => [key as number] },
  ],
  tier: "analysis",
  transfer(ctx: PassCtx, key: number): number | undefined {
    const raw = ctx.read(runtimeCallPass, key);
    return Math.min(RUNTIME_CALL_COUNT_SAT, raw);
  },
};
