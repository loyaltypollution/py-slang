// src/specialization/index.ts — public API barrel

// ── Pipeline entry points ────────────────────────────────────────────────────
//
// Production callers use `SpecializationEngine` for the full reactive
// lifecycle. `createReactiveOptimization` returns a raw PersistentWorklist
// and is @internal for tests and advanced consumers only.

import type { StmtNS } from "../ast-types";
import type { FunctionEnvironments } from "../resolver";
import { PersistentWorklist } from "./framework/persistent-worklist";
import { createAnalyses, createTransforms } from "./pipeline-config";

export { SpecializationEngine } from "./engine";

/**
 * @internal Build a `PersistentWorklist` pre-loaded with the default
 * analyses and transforms. For tests and advanced consumers that drive the
 * reactive loop directly; production callers use `SpecializationEngine`.
 */
export function createReactiveOptimization(
  ast: StmtNS.FileInput,
  functionEnvironments: FunctionEnvironments,
): PersistentWorklist {
  return new PersistentWorklist(ast, functionEnvironments, createAnalyses(), createTransforms());
}

// ── FunctionUnit (per-scope optimization grouping) ──────────────────────────

export type { FunctionUnit } from "./framework/function-unit";
export { buildFunctionUnits } from "./framework/function-unit";

// ── Persistent worklist ─────────────────────────────────────────────────────

export { PersistentWorklist } from "./framework/persistent-worklist";
export type { ExternalWorkItem, Subscriber, WorklistStats } from "./framework/persistent-worklist";
export type { ObservationSink } from "./framework/persistent-worklist";
export { assertSyncObservationSink } from "./framework/persistent-worklist";
export type { SlotInfo, SlotLookup } from "./framework/slot-table";
export { buildSlotTable } from "./framework/slot-table";

// ── Framework (for manual wiring / tests) ────────────────────────────────────

export type {
  AnalysisModule,
  TransformRule,
  StmtTransformRule,
  ExprTransformRule,
} from "./framework/interfaces";
export type { LatticeEquality, OptimizationHint } from "./framework/hint";
export { HintStore, hintEquals } from "./framework/hint";
export {
  MutableEnv,
  runAnalysisPass,
  runMultiAnalysisPasses,
  stabilizeStatic,
} from "./framework/dfa-driver";
export { OSRCoordinator, InPlaceASTStrategy } from "./framework/osr";
export type { StateDeltaStrategy, OSRStats } from "./framework/osr";

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
export { MemoizationTransformRule } from "./transforms/memoization";
export {
  MemoizationAnalysisModule,
  MEMOIZATION_THRESHOLD,
  CALL_COUNT_FIELD,
  MEMOIZED_FIELD,
} from "./memoization-analysis/analysis";
export {
  memoHas,
  memoGet,
  memoPut,
  clearMemoCache,
  memoCacheSnapshot,
  MEMO_MISS,
} from "./memoization-analysis/runtime";
