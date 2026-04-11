// src/specialization/optimize.ts — single entry point for the static optimization pipeline

import type { StmtNS } from "../ast-types";
import type { FunctionEnvironments } from "../resolver";
import { stabilizeStatic } from "./framework/dfa-driver";
import type { FunctionUnit } from "./framework/function-unit";
import { buildFunctionUnits } from "./framework/function-unit";
import { TypeAnalysisModule } from "./type-analysis/analysis";
import { ConstAnalysisModule } from "./const-analysis/analysis";
import { ConstantFoldingRule } from "./transforms/constant-folding";
import { DeadBranchEliminationRule } from "./transforms/dead-branch";

const analyses = () => [new TypeAnalysisModule(), new ConstAnalysisModule()];
const transforms = () => [new DeadBranchEliminationRule(), new ConstantFoldingRule()];

/**
 * Run the full static optimization pipeline.
 *
 * Builds a FunctionUnit tree (one per scope), then runs
 * analyze → transform → re-analyze per unit until stable.
 *
 * Returns the root FunctionUnit. Consumers pull hints per-unit.
 */
export function optimize(
  ast: StmtNS.FileInput,
  functionEnvironments: FunctionEnvironments,
): FunctionUnit {
  const root = buildFunctionUnits(ast, functionEnvironments);
  optimizeUnit(root);
  return root;
}

function optimizeUnit(unit: FunctionUnit): void {
  stabilizeStatic(
    unit.body,
    analyses(),
    transforms(),
    unit.hints,
    unit.slotTable.lookup,
  );
  unit.version = 1;

  for (const child of unit.children) {
    optimizeUnit(child);
  }
}
