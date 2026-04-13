// src/specialization/memoization-analysis/call-count.ts
//
// Public constants for the memoization call-count gate. The legacy
// `CallCountScopePass` class (a `ScopePass` registered on the worklist)
// has been demolished in PR-6b: its count-folding body is now the
// saturating-bucket transfer of `callCountPass` (see
// `../framework/migrated-passes.ts`), fed by `runtimeCallPass` writes
// that `Worklist.observeCall` dispatches on each recorded call.
//
// Only the hint-field name and the firing threshold remain here — both
// are still consumed by `MemoizationTransformRule.matches` as the
// hint-surface keys into `OptimizationHint`.

/** Number of recorded calls after which MemoizationTransformRule may fire. */
export const MEMOIZATION_THRESHOLD = 10;

/** Name of the hint field this pass writes to. */
export const CALL_COUNT_FIELD = "callCount" as const;
