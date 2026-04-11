// src/specialization/index.ts — public API barrel

// ── Pipeline entry point ─────────────────────────────────────────────────────

export { optimize } from "./optimize";

// ── FunctionUnit (per-scope optimization grouping) ──────────────────────────

export type { FunctionUnit } from "./framework/function-unit";
export { buildFunctionUnits } from "./framework/function-unit";
export type { SlotInfo, SlotLookup } from "./framework/slot-table";
export { buildSlotTable } from "./framework/slot-table";

// ── Framework (for manual wiring / tests) ────────────────────────────────────

export type {
  AnalysisModule,
  TransformRule,
  StmtTransformRule,
  ExprTransformRule,
} from "./framework/interfaces";
export type { OptimizationHint } from "./framework/hint";
export { HintStore } from "./framework/hint";
export {
  MutableEnv,
  runAnalysisPass,
  runMultiAnalysisPasses,
  stabilizeStatic,
} from "./framework/dfa-driver";

// ── CFG worklist driver ─────────────────────────────────────────────────────

export type { BlockId, BasicBlock, CFG } from "./framework/cfg";
export { buildCFG } from "./framework/cfg";
export { runCFGOptimization } from "./framework/worklist";

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
