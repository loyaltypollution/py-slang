// src/specialization/optimize.ts — optimization entry points

import type { StmtNS } from "../ast-types";
import type { FunctionEnvironments } from "../resolver";
import type { FunctionUnit } from "./framework/function-unit";
import { PersistentWorklist } from "./framework/persistent-worklist";
import { createAnalyses, createTransforms } from "./pipeline-config";

/** Build a worklist pre-loaded with the default pipeline. */
export function createReactiveOptimization(
  ast: StmtNS.FileInput,
  functionEnvironments: FunctionEnvironments,
): PersistentWorklist {
  return new PersistentWorklist(ast, functionEnvironments, createAnalyses(), createTransforms());
}

/** Run the full static optimization pipeline to fixpoint. */
export function optimize(
  ast: StmtNS.FileInput,
  functionEnvironments: FunctionEnvironments,
): ReadonlyMap<StmtNS.FileInput | StmtNS.FunctionDef, FunctionUnit> {
  const worklist = createReactiveOptimization(ast, functionEnvironments);
  worklist.drain();
  return worklist.units;
}
