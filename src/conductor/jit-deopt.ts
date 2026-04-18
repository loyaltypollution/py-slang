import { SpeculationViolation } from "../engines/svml/errors";
import { Worklist } from "../specialization";

/** Cap on consecutive deopts before giving up. A speculation that violates
 *  on every retry indicates a bug in the speculative analysis or in our
 *  widening protocol — running forever would just hang. */
export const MAX_DEOPT_RETRIES = 32;

/** Drive an async executor with JIT deopt-and-retry. On `SpeculationViolation`,
 *  call `worklist.widenGuard(nodeId)` to prune the load-bearing assumptions;
 *  the worklist fires `specContextChange`, which wakes jit-keyed analyses
 *  and patches the function table on the next drain. Bounded by
 *  `MAX_DEOPT_RETRIES` to avoid infinite loops on a buggy speculator.
 *
 *  `shouldRethrow` lets the caller propagate its own control-flow
 *  signals (e.g. an `AbortError` from a caller-specific race) without
 *  engaging the deopt path. */
export async function runWithDeopt<T>(
  execute: () => T | Promise<T>,
  worklist: Worklist,
  shouldRethrow?: (e: unknown) => boolean,
): Promise<T> {
  let attempts = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      return await execute();
    } catch (e) {
      if (shouldRethrow?.(e)) throw e;
      if (!(e instanceof SpeculationViolation)) throw e;
      if (++attempts > MAX_DEOPT_RETRIES) {
        throw new Error(
          `JIT deopt budget exhausted (${MAX_DEOPT_RETRIES}); last violation at node ${e.nodeId} (${e.witnessedKind})`,
        );
      }
      worklist.widenGuard(e.nodeId);
      // observe() drains automatically when batchDepth permits; inside
      // beginBatch we need to drain explicitly so the JIT recompile
      // analysis fires and patches the function table before retry.
      worklist.drain();
    }
  }
}
