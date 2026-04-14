// Call-count gate for memoization; saturating fold over runtimeCallPass writes.

import { StmtNS } from "../../ast-types";
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
    {
      on: "retire",
      effect: (ctx, unit) => {
        const fd = unit.funcAst;
        if (fd instanceof StmtNS.FunctionDef) {
          ctx.factStore.evict(callCountPass, fd.id);
        }
      },
    },
  ],
  tier: "analysis",
  transfer(ctx: PassCtx, key: number): number | undefined {
    const raw = ctx.read(runtimeCallPass, key);
    return Math.min(RUNTIME_CALL_COUNT_SAT, raw);
  },
};
