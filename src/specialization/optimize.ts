// src/specialization/optimize.ts — single entry point for the static optimization pipeline

import type { StmtNS } from "../ast-types";
import type { FunctionEnvironments } from "../resolver";
import { ConstAnalysisModule } from "./const-analysis/analysis";
import type { FunctionUnit } from "./framework/function-unit";
import { buildFunctionUnits } from "./framework/function-unit";
import { runCFGOptimization } from "./framework/worklist";
import { ConstantFoldingRule } from "./transforms/constant-folding";
import { DeadBranchEliminationRule } from "./transforms/dead-branch";
import { TypeAnalysisModule } from "./type-analysis/analysis";

const analyses = () => [new TypeAnalysisModule(), new ConstAnalysisModule()];
const transforms = () => [new DeadBranchEliminationRule(), new ConstantFoldingRule()];

/**
 * Run the full static optimization pipeline.
 *
 * Builds one FunctionUnit per scope, then runs CFG-based worklist DFA
 * (analyze → transform → rebuild CFG) per unit until stable.
 * Returns the flat map for the compiler to look up hints.
 */
export function optimize(
  ast: StmtNS.FileInput,
  functionEnvironments: FunctionEnvironments,
): Map<StmtNS.FileInput | StmtNS.FunctionDef, FunctionUnit> {
  const units = buildFunctionUnits(ast, functionEnvironments);
  for (const unit of units.values()) {
    runCFGOptimization(unit.body, analyses(), transforms(), unit.hints, unit.slotLookup);
  }
  return units;
}
