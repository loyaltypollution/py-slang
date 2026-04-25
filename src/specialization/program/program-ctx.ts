import type { AnalysisCtx } from "../framework/analysis";
import type { FunctionView } from "./views/function-view";

/** Transfer-time context augmented with program-shape accessors. The Worklist
 *  always constructs a `ProgramCtx`; the framework's signature only promises
 *  `AnalysisCtx`, so analyses cast at the access site via `asProgramCtx`. */
export interface ProgramCtx extends AnalysisCtx, FunctionView {}

export function asProgramCtx(ctx: AnalysisCtx): ProgramCtx {
  return ctx as ProgramCtx;
}
