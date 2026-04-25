import type { AnalysisCtx } from "../framework/analysis";
import type { FunctionView } from "./program-view";

/** Transfer-time context augmented with program-shape accessors.
 *
 *  The framework's `AnalysisCtx` knows nothing about Functions, BasicBlocks,
 *  or any specific view kind. The Worklist runtime constructs a `ProgramCtx`
 *  for every transfer — it combines `AnalysisCtx`'s generic store-access
 *  surface with `FunctionView`'s function-view-manager handle. Analyses that
 *  need program access cast via `asProgramCtx(ctx)` at the boundary.
 *
 *  This is the seam between framework (view-shape-agnostic) and program
 *  (view-shape-specific). The cast is the contract. */
export interface ProgramCtx extends AnalysisCtx, FunctionView {}

/** Cast helper. The Worklist guarantees every ctx it constructs at runtime
 *  is a `ProgramCtx`; the framework's signature only promises `AnalysisCtx`,
 *  so analyses cast at the access site. */
export function asProgramCtx(ctx: AnalysisCtx): ProgramCtx {
  return ctx as ProgramCtx;
}
