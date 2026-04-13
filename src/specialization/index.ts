// src/specialization/index.ts — public API barrel

// ── FunctionUnit (per-scope optimization grouping) ──────────────────────────

export type { FunctionUnit } from "./framework/function-unit";
export { buildFunctionUnits } from "./framework/function-unit";

// ── Persistent worklist ─────────────────────────────────────────────────────

export { Worklist } from "./framework/worklist";
export type { WorklistStats } from "./framework/worklist";

// ── Pass-graph framework (runtime-tier exports for evaluator wiring) ──────

export type { Pass, PassCtx, Lattice } from "./framework/pass";
export { runtimeWritePass, runtimeCallPass } from "./framework/runtime-passes";
export { callCountPass } from "./memoization-analysis/call-count";
export { purityScopePass } from "./purity-analysis/analysis";
export { structuralPass } from "./framework/structural-pass";

// ── Framework (for manual wiring / tests) ────────────────────────────────────

export type { AnalysisPass } from "./framework/interfaces";

// ── Type lattice (codegen reads kind bits + refinements from hints) ──────────

export type { TypeLattice } from "./type-analysis/lattice";
export {
  INT_BIT,
  BOOL_BIT,
  STR_BIT,
  NULL_BIT,
  CLOSURE_BIT,
  FLOAT_BIT,
  COMPLEX_BIT,
  IntRef,
  BoolRef,
  join,
  meet,
  leq,
  TOP,
  BOTTOM,
  integer,
  positiveInteger,
  negativeInteger,
  zeroInteger,
  boolean,
  trueValue,
  falseValue,
  floatValue,
  positiveFloat,
  negativeFloat,
  zeroFloat,
  complexValue,
  stringValue,
  nullValue,
  closureValue,
} from "./type-analysis/lattice";

// ── Concrete analyses ────────────────────────────────────────────────────────

export { TypeAnalysisPass } from "./type-analysis/analysis";
export { ConstAnalysisPass, constLeq, constJoin, constMeet } from "./const-analysis/analysis";
export type { ConstLattice, ConstValue } from "./const-analysis/lattice";
export { CONST_BOTTOM, CONST_TOP, constOf } from "./const-analysis/lattice";

// ── Concrete transforms ──────────────────────────────────────────────────────

export { applyMemoizationWrap, memoizationRule } from "./transforms/memoization";
export { MEMOIZATION_THRESHOLD } from "./memoization-analysis/call-count";
export { PURE_FIELD } from "./purity-analysis/lattice";
export { memoLookup, memoPut, clearMemoCache, memoCacheSnapshot, MEMO_MISS } from "../runtime/memo";
