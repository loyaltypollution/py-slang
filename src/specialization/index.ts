// src/specialization/index.ts — public API barrel

// ── Pipeline entry point ─────────────────────────────────────────────────────

export { optimize } from "./optimize";

// ── Framework (for manual wiring / tests) ────────────────────────────────────

export type { AnalysisModule, TransformRule, StmtTransformRule, ExprTransformRule } from "./framework/interfaces";
export type { OptimizationHint, HintTable, Annotated, PyASTNode } from "./framework/hint";
export { annotateTree } from "./framework/hint";
export {
  MutableEnv,
  runAnalysisPass,
  runMultiAnalysisPasses,
  applyTransformPass,
  stabilizeStatic,
} from "./framework/dfa-driver";

// ── Bridge types (compiler ↔ analysis) ───────────────────────────────────────

export type { SlotInfo, SlotLookup } from "./types";

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

export { TypeAnalysisModule } from "./type-analysis/analysis";
export { ConstAnalysisModule, constLeq, constJoin, constMeet } from "./const-analysis/analysis";
export type { ConstLattice, ConstValue } from "./const-analysis/lattice";
export { CONST_BOTTOM, CONST_TOP, constOf } from "./const-analysis/lattice";

// ── Concrete transforms ──────────────────────────────────────────────────────

export { ConstantFoldingRule } from "./transforms/constant-folding";
export { DeadBranchEliminationRule } from "./transforms/dead-branch";
