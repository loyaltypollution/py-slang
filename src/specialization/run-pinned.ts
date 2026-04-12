import type { StmtNS } from "../ast-types";
import type { OSRCoordinator } from "./framework/osr";
import type { PersistentWorklist } from "./framework/persistent-worklist";

/**
 * Pin `rootScope` for the duration of `fn`, running a state-delta
 * coordinator (if any) alongside.
 *
 * The critical invariant: an in-flight throw leaves pins dirty — CSE does
 * not pop envs during JS-stack unwind, so any FunctionDef envs still on
 * `context.runtime.environments` never ran their leave-hook. Rather than
 * reconstructing the correct set, reset on throw via `clearAllPins` —
 * the evaluation is aborted anyway, and the next run starts fresh.
 *
 * `withActiveScope`'s own finally block suppresses the success-path tick
 * when `fn` throws, preserving the tick-on-success / no-tick-on-throw
 * asymmetry that the worklist depends on for queue draining.
 */
export async function runPinned<T>(
  worklist: PersistentWorklist,
  coordinator: OSRCoordinator<unknown> | null,
  rootScope: StmtNS.FileInput | StmtNS.FunctionDef,
  fn: () => Promise<T> | T,
): Promise<T> {
  const stop = coordinator?.start();
  try {
    return await worklist.withActiveScope(rootScope, fn);
  } catch (e) {
    worklist.clearAllPins();
    throw e;
  } finally {
    stop?.();
  }
}
