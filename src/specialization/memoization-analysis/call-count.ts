// src/specialization/memoization-analysis/call-count.ts
//
// Public constants for the memoization call-count gate. The legacy
// `CallCountScopePass` class (a `ScopePass` registered on the worklist)
// has been demolished in PR-6b: its count-folding body is now the
// saturating-bucket transfer of `callCountPass` (see
// `../framework/migrated-passes.ts`), fed by `runtimeCallPass` writes
// that `Worklist.observeCall` dispatches on each recorded call.
//
// Only the firing threshold remains here.

/** Number of recorded calls after which MemoizationTransformRule may fire. */
export const MEMOIZATION_THRESHOLD = 10;
