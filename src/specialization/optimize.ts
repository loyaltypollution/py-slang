// src/specialization/optimize.ts — lower-level optimization entry points
//
// Production JIT and CSE paths construct a `SpecializationEngine` which owns
// the worklist, the OSR coordinator, and the reactive lifecycle. The helpers
// below are escape hatches for callers that deliberately want less:
//
//  - `optimize(ast, env)` runs the static pipeline to fixpoint and returns
//    just the per-scope `FunctionUnit` map. Used by `PySvmlEvaluator` (the
//    non-JIT SVML path) which compiles once against the converged units and
//    never needs a live reactive loop.
//
//  - `createReactiveOptimization(ast, env)` returns the raw `PersistentWorklist`
//    for tests and advanced consumers that need to drive the worklist
//    directly (subscribe, tick, enqueue observations). New callers should
//    prefer `SpecializationEngine.create` unless they truly need the raw
//    worklist surface.

import type { StmtNS } from "../ast-types";
import type { FunctionEnvironments } from "../resolver";
import type { FunctionUnit } from "./framework/function-unit";
import { PersistentWorklist } from "./framework/persistent-worklist";
import { createAnalyses, createTransforms } from "./pipeline-config";

/**
 * @internal Construct a `PersistentWorklist` pre-loaded with the default
 * analyses and transforms. Used by tests that drive the reactive loop
 * directly (subscribe, tick, enqueue, inspect stats). Production code uses
 * `SpecializationEngine.create`, which owns the worklist, coordinator, and
 * reactive lifecycle end-to-end.
 */
export function createReactiveOptimization(
  ast: StmtNS.FileInput,
  functionEnvironments: FunctionEnvironments,
): PersistentWorklist {
  return new PersistentWorklist(ast, functionEnvironments, createAnalyses(), createTransforms());
}

/**
 * Run the static optimization pipeline to fixpoint and return the resulting
 * per-scope unit map. No reactive loop, no OSR. Used by `PySvmlEvaluator`
 * (non-JIT) to drive one-shot compilation against converged hints.
 */
export function optimize(
  ast: StmtNS.FileInput,
  functionEnvironments: FunctionEnvironments,
): ReadonlyMap<StmtNS.FileInput | StmtNS.FunctionDef, FunctionUnit> {
  const worklist = createReactiveOptimization(ast, functionEnvironments);
  worklist.drain();
  return worklist.units;
}
