// Default transform rule set. Only `defaults.ts` consumes these; new
// transforms are registered here so the composition layer doesn't have to
// know individual file paths.

export { algebraicSimplifyRule } from "./algebraic-simplify";
export { constantFoldingRule } from "./constant-folding";
export { deadBranchRule } from "./dead-branch";
export { deadStoreRule } from "./dead-store";
export { memoizationRule } from "./memoization";
