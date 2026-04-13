// Number of recorded calls after which `shouldMemoize` fires.
// Consumed by `callCountOf` (saturation) and `shouldMemoize` in
// `runtime/queries/scope.ts`.
export const MEMOIZATION_THRESHOLD = 10;
