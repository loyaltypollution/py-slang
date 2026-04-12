// src/specialization/optimize.ts — one-shot static optimization entry point

import type { StmtNS } from "../ast-types";
import type { FunctionEnvironments } from "../resolver";
import type { FunctionUnit } from "./framework/function-unit";
import { buildVersionedFunctionUnits } from "./framework/function-unit";
import { PersistentWorklist } from "./framework/persistent-worklist";
import { createAnalyses, createTransforms } from "./pipeline-config";

/**
 * Run the full static optimization pipeline to fixpoint.
 *
 * Builds one FunctionUnit per scope, registers all with a PersistentWorklist,
 * and drains until idle. Returns the flat map for the compiler to look up hints.
 */
export function optimize(
  ast: StmtNS.FileInput,
  functionEnvironments: FunctionEnvironments,
): Map<StmtNS.FileInput | StmtNS.FunctionDef, FunctionUnit> {
  const units = buildVersionedFunctionUnits(ast, functionEnvironments);
  const worklist = new PersistentWorklist(createAnalyses(), createTransforms());
  for (const [key, unit] of units) worklist.addScope(key, unit);
  worklist.drain();
  return units;
}
