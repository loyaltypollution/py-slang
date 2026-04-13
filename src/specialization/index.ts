// src/specialization/index.ts — public API barrel

// ── FunctionUnit (per-scope optimization grouping) ──────────────────────────

export type { FunctionUnit } from "./framework/function-unit";
export { buildFunctionUnits } from "./framework/function-unit";

// ── Persistent worklist ─────────────────────────────────────────────────────

export { Worklist } from "./framework/worklist";
export type { WorklistStats, ScopeChangeListener } from "./framework/worklist";
export type { ObservationSink } from "./framework/observation-sink";

// ── Framework (for manual wiring / tests) ────────────────────────────────────

export type { AnalysisPass, ScopePass, TransformRule } from "./framework/interfaces";
export type { OptimizationHint } from "./framework/hint";
export { HintStore } from "./framework/hint";

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

export { ConstantFoldingRule } from "./transforms/constant-folding";
export { DeadBranchEliminationRule } from "./transforms/dead-branch";
export { MemoizationTransformRule } from "./transforms/memoization";
export {
  CallCountScopePass,
  MEMOIZATION_THRESHOLD,
  CALL_COUNT_FIELD,
  MEMOIZED_FIELD,
} from "./memoization-analysis/call-count";
export {
  PurityEffectAnalysis,
  PURE_EFFECT_FIELD,
  type PureEffect,
} from "./memoization-analysis/purity-effect";
export { PurityScopePass, PURE_FIELD } from "./memoization-analysis/purity-summary";
export { memoLookup, memoPut, clearMemoCache, memoCacheSnapshot, MEMO_MISS } from "../runtime/memo";
