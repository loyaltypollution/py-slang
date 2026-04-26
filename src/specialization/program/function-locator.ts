import type { NodeId } from "./node-set";
import type { BasicBlock } from "./basic-block";
import type { Function, FunctionId } from "./function";
import type { UnitLocator } from "../framework/unit-domain";

/** Read-only program-wide lookup surface for `Function`.
 *
 *  Owned by `FunctionManager`. Consumers that need program-shape lookup
 *  take this as an explicit dependency rather than casting `AnalysisCtx`
 *  to a richer ctx.
 *
 *  Extends `UnitLocator<Function>` (the minimum surface generic worklist
 *  code needs) with function-specific queries used by analyses,
 *  transforms, and observation ingress. */
export interface FunctionLocator extends UnitLocator<Function> {
  /** Lookup by FunctionId boundary key (typically `funcAst.id`). */
  functionById(id: FunctionId): Function | undefined;
  /** Resolve the BasicBlock that owns `nodeId`, or undefined if `nodeId`
   *  is not part of any indexed function. */
  blockContaining(nodeId: NodeId): BasicBlock | undefined;
}
