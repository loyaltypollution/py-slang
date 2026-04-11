// src/specialization/optimize.ts — single entry point for the static optimization pipeline

import type { StmtNS } from "../ast-types";
import type { FunctionEnvironments } from "../resolver";
import { ConstAnalysisModule } from "./const-analysis/analysis";
import type { FunctionUnit } from "./framework/function-unit";
import { buildFunctionUnits } from "./framework/function-unit";
import { OptimizationSession } from "./framework/session";
import { ConstantFoldingRule } from "./transforms/constant-folding";
import { DeadBranchEliminationRule } from "./transforms/dead-branch";
import { TypeAnalysisModule } from "./type-analysis/analysis";

const analyses = () => [new TypeAnalysisModule(), new ConstAnalysisModule()];
const transforms = () => [new DeadBranchEliminationRule(), new ConstantFoldingRule()];

/**
 * Run the full static optimization pipeline.
 *
 * Builds one FunctionUnit per scope, creates an OptimizationSession per unit,
 * and runs each to convergence. Returns the flat map for the compiler to look up hints.
 */
export function optimize(
  ast: StmtNS.FileInput,
  functionEnvironments: FunctionEnvironments,
): Map<StmtNS.FileInput | StmtNS.FunctionDef, FunctionUnit> {
  const units = buildFunctionUnits(ast, functionEnvironments);
  for (const unit of units.values()) {
    const session = new OptimizationSession(
      unit.body, analyses(), transforms(), unit.hints, unit.slotLookup,
    );
    session.converge();
  }
  return units;
}

/**
 * Create sessions for consumers that want to control stepping.
 * Each session corresponds to one FunctionUnit (scope).
 */
export function createOptimizationSessions(
  ast: StmtNS.FileInput,
  functionEnvironments: FunctionEnvironments,
): Map<StmtNS.FileInput | StmtNS.FunctionDef, { unit: FunctionUnit; session: OptimizationSession }> {
  const units = buildFunctionUnits(ast, functionEnvironments);
  const result = new Map<
    StmtNS.FileInput | StmtNS.FunctionDef,
    { unit: FunctionUnit; session: OptimizationSession }
  >();
  for (const [key, unit] of units) {
    const session = new OptimizationSession(
      unit.body, analyses(), transforms(), unit.hints, unit.slotLookup,
    );
    result.set(key, { unit, session });
  }
  return result;
}
