// src/specialization/memoization-analysis/call-count.ts
//
// CallCountScopePass — scope-level, one-shot pass that folds the per-unit
// `callObservations` buffer into a saturating `callCount` hint on the
// owning FunctionDef. Runs once per scope per generation from the
// worklist's transform phase; read by MemoizationTransformRule as the
// threshold gate.
//
// Call counts don't fit a Kildall transfer — incrementing on every
// observed call has no natural fixpoint on a cyclic call graph (n+1 is
// never leq n under ℕ). The shape we actually need is "walk each scope
// once, count". ScopePass models exactly that.

import { StmtNS } from "../../ast-types";
import type { ScopePass } from "../framework/interfaces";
import type { FunctionUnit } from "../framework/function-unit";

/** Number of recorded calls after which MemoizationTransformRule may fire. */
export const MEMOIZATION_THRESHOLD = 10;

/** Name of the hint field this pass writes to. */
export const CALL_COUNT_FIELD = "callCount" as const;

export class CallCountScopePass implements ScopePass {
  readonly name = "callCount";
  readonly writesFields = [CALL_COUNT_FIELD] as const;

  run(unit: FunctionUnit): void {
    // Only FunctionDefs can be memoization callees; calls to FileInput
    // (top-level-as-callee) are nonsensical for this pass.
    const fd = unit.funcAst;
    if (!(fd instanceof StmtNS.FunctionDef)) return;

    const observed = unit.callObservations.length;
    if (observed === 0) return; // don't materialize the field until first call
    const saturated = Math.min(observed, MEMOIZATION_THRESHOLD + 1);
    unit.hints.updateField(fd.id, CALL_COUNT_FIELD, saturated);
  }
}
