// src/specialization/memoization-analysis/analysis.ts
//
// CallCountObserver — accumulates a saturating per-FunctionDef call count
// by reacting to the worklist's `observeCall` dispatch. Pure profile
// machinery: no lattice, no transfer function, no expression visitor.
// Registered on a Worklist via `addProfileObserver`.
//
// The count is stored as a plain number on the callee FunctionDef's
// `OptimizationHint` under the field `callCount`, so
// `MemoizationTransformRule` can read it with `hints.get(fd)?.callCount`.
// Saturates at `MEMOIZATION_THRESHOLD + 1` so the hint never grows
// unboundedly.

import { StmtNS } from "../../ast-types";
import type { ProfileObserver } from "../framework/interfaces";
import type { HintStore, OptimizationHint } from "../framework/hint";

/** Number of recorded calls after which MemoizationTransformRule may fire. */
export const MEMOIZATION_THRESHOLD = 10;

/** Name of the open-record hint field this observer writes to. */
export const CALL_COUNT_FIELD = "callCount";

/** Hint field the transform sets on a FunctionDef after wrapping it. */
export const MEMOIZED_FIELD = "memoized";

export class CallCountObserver implements ProfileObserver {
  /**
   * Bump the callee's saturating call counter. The counter lives on the
   * callee FunctionDef's hint (keyed by its node.id);
   * `MemoizationTransformRule` reads it back via
   * `hints.get(fd)?.callCount`.
   */
  onCallObservation(
    _callerKey: StmtNS.FileInput | StmtNS.FunctionDef,
    calleeKey: StmtNS.FileInput | StmtNS.FunctionDef,
    calleeHints: HintStore,
  ): void {
    // Only count calls to user-defined FunctionDefs — FileInput-as-callee
    // would mean the top-level scope is being "called", which is nonsensical
    // here and never eligible for memoization.
    if (!(calleeKey instanceof StmtNS.FunctionDef)) return;
    const prev = calleeHints.get(calleeKey) ?? {};
    const prevCount =
      typeof prev[CALL_COUNT_FIELD] === "number" ? (prev[CALL_COUNT_FIELD] as number) : 0;
    const next = Math.min(prevCount + 1, MEMOIZATION_THRESHOLD + 1);
    if (next === prevCount) return;
    const nextHint: OptimizationHint = { ...prev, [CALL_COUNT_FIELD]: next };
    calleeHints.set(calleeKey, nextHint);
  }
}
