// src/specialization/pipeline-config.ts — shared analysis/transform pipeline factories

import { ConstAnalysisModule } from "./const-analysis/analysis";
import type { AnalysisModule, TransformRule } from "./framework/interfaces";
import { ConstantFoldingRule } from "./transforms/constant-folding";
import { DeadBranchEliminationRule } from "./transforms/dead-branch";
import { TypeAnalysisModule } from "./type-analysis/analysis";

/** Build a fresh list of analysis modules. Callers own the instances. */
export const createAnalyses = (): AnalysisModule<any>[] => [
  new TypeAnalysisModule(),
  new ConstAnalysisModule(),
];

/** Build a fresh list of transform rules. Callers own the instances. */
export const createTransforms = (): TransformRule[] => [
  new DeadBranchEliminationRule(),
  new ConstantFoldingRule(),
];
