// src/specialization/pipeline-config.ts — shared analysis/transform pipeline factories

import { ConstAnalysisModule } from "./const-analysis/analysis";
import type { AnalysisModule, TransformRule } from "./framework/interfaces";
import { MemoizationAnalysisModule } from "./memoization-analysis/analysis";
import { ConstantFoldingRule } from "./transforms/constant-folding";
import { DeadBranchEliminationRule } from "./transforms/dead-branch";
import { MemoizationTransformRule } from "./transforms/memoization";
import { TypeAnalysisModule } from "./type-analysis/analysis";

/** Build a fresh list of analysis modules. Callers own the instances. */
export const createAnalyses = (): AnalysisModule<unknown>[] => [
  new TypeAnalysisModule(),
  new ConstAnalysisModule(),
  // Memoization bumps a per-FunctionDef call counter via onCallObservation.
  // Order after the transfer-function analyses so transforms gated on both
  // purity and count see fully-populated hints.
  new MemoizationAnalysisModule(),
];

/** Build a fresh list of transform rules. Callers own the instances. */
export const createTransforms = (): TransformRule[] => [
  new DeadBranchEliminationRule(),
  new ConstantFoldingRule(),
  new MemoizationTransformRule(),
];
