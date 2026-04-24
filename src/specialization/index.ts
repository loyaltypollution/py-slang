// Public surface. Everything outside src/specialization/ and src/tests/
// must import from here — deep imports are forbidden by lint. Tests may
// reach into internals to exercise them.

export { createDefaultWorklist } from "./defaults";
export { makeDfaQuery, type DfaQuery, type StaticDfaQuery } from "./dfa-query";
export {
  makeJitDispatch,
  type DispatchOutcome,
  type JitDispatch,
} from "./observation/jit-dispatch";
export type { Unit } from "./framework/function-unit";
