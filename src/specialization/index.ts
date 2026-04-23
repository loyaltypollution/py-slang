// Conductor-facing public surface.
//
// Barrel policy: this module re-exports only what `src/conductor/*` needs to
// wire up a JIT evaluator. Engines (`src/engines/*`) and tests import directly
// from `./framework/*` and sibling subpaths — the barrel is not the canonical
// internal entry point.

export { Worklist } from "./framework/worklist";
export {
  makeDfaQuery,
  type DfaQuery,
  type StaticDfaQuery,
} from "./dfa-query";
export { makeJitObservers } from "./framework/runtime-analyses";
export { bodyToCompile, dispatchValid } from "./framework/dispatch";
