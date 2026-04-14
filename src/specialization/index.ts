// Public API barrel.

export { Worklist } from "./framework/worklist";
export { runtimeWritePass, runtimeCallPass, RUNTIME_CALL_COUNT_SAT } from "./framework/runtime-passes";
export { structuralPass } from "./framework/structural-pass";
export { callCountPass, MEMOIZATION_THRESHOLD } from "./memoization-analysis/call-count";
export { purityScopePass } from "./purity-analysis/analysis";

// Type lattice: codegen reads kind bits + refinements from hints.
export {
  INT_BIT,
  BOOL_BIT,
  FLOAT_BIT,
  COMPLEX_BIT,
  IntRef,
  BoolRef,
  TOP,
  positiveInteger,
  negativeInteger,
  zeroInteger,
  trueValue,
  falseValue,
  positiveFloat,
  negativeFloat,
  zeroFloat,
  complexValue,
  stringValue,
} from "./type-analysis/lattice";

export { TypeAnalysisPass } from "./type-analysis/analysis";
export { ConstAnalysisPass } from "./const-analysis/analysis";
export { CONST_BOTTOM, CONST_TOP, constJoin, constLeq, constMeet, constOf } from "./const-analysis/lattice";

export { memoizationRule } from "./transforms/memoization";
export { memoLookup, memoPut, clearMemoCache, memoCacheSnapshot, MEMO_MISS } from "../runtime/memo";
