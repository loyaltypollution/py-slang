// Conductor-facing public surface. Re-exports only what `src/conductor/*`
// needs to wire a JIT evaluator. Engines and tests import directly from
// `./framework/*` and sibling subpaths.

export { Worklist } from "./framework/worklist";
export {
  makeDfaQuery,
  type DfaQuery,
  type StaticDfaQuery,
} from "./dfa-query";
export { makeJitObservers } from "./framework/runtime-analyses";
export { makeJitDispatch, type DispatchOutcome, type JitDispatch } from "./framework/jit-dispatch";
