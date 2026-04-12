// src/specialization/optimize.ts — raw worklist escape hatch.
//
// Production JIT / CSE / non-JIT SVML paths construct a `SpecializationEngine`,
// which owns the worklist, the OSR coordinator, and the reactive lifecycle.
// This file exists only for tests and advanced consumers that need to drive
// the worklist directly: subscribe/tick/enqueue/inspect stats.
//
// New callers should prefer `SpecializationEngine` unless they truly need
// the raw worklist surface.

import type { StmtNS } from "../ast-types";
import type { FunctionEnvironments } from "../resolver";
import { PersistentWorklist } from "./framework/persistent-worklist";
import { createAnalyses, createTransforms } from "./pipeline-config";

/**
 * @internal Construct a `PersistentWorklist` pre-loaded with the default
 * analyses and transforms. For tests and advanced consumers that drive the
 * reactive loop directly.
 */
export function createReactiveOptimization(
  ast: StmtNS.FileInput,
  functionEnvironments: FunctionEnvironments,
): PersistentWorklist {
  return new PersistentWorklist(ast, functionEnvironments, createAnalyses(), createTransforms());
}
