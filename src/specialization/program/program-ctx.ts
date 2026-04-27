import type { AnalysisCtx } from "../framework/analysis";
import type { FunctionRegistry } from "./function-keys";

/** Transfer-time context augmented with program-shape accessors.
 *
 *  The framework's `AnalysisCtx` is Function-agnostic — it knows reads,
 *  writes, and chain walks but nothing about Functions or BasicBlocks. The
 *  Worklist runtime constructs a `ProgramCtx` for every transfer, mixing
 *  in `FunctionRegistry`'s function-lookup surface (backed by
 *  `FunctionManager`). Analyses that need program access cast via
 *  `asProgramCtx(ctx)` at the boundary.
 *
 *  This is the seam between framework (Function-agnostic) and program
 *  (Function-specific). The cast is the contract. */
export interface ProgramCtx extends AnalysisCtx, FunctionRegistry {}

/** Cast helper. The Worklist guarantees every ctx it constructs at runtime
 *  is a `ProgramCtx`; the framework's signature only promises `AnalysisCtx`,
 *  so analyses cast at the access site. */
export function asProgramCtx(ctx: AnalysisCtx): ProgramCtx {
  return ctx as ProgramCtx;
}
