// Public surface. External consumers import from here; deep imports are
// lint-forbidden. Tests may reach into internals.

export { createDefaultWorklist } from "./defaults";
export { makeDfaQuery, type DfaQuery, type StaticDfaQuery } from "./dfa-query";
export {
  makeJitDispatch,
  type DispatchOutcome,
  type JitDispatch,
} from "./observation/jit-dispatch";
export type { Unit } from "./framework/function-unit";
