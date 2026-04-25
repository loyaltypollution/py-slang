import type { AnalysisCtx } from "../../framework/analysis";
import type { BasicBlock } from "./basic-block";
import type { Function } from "./function";
import { asProgramCtx } from "../program-ctx";
import type { NodeId } from "../node-set";
import type { FunctionId } from "./function-view";

/** Resolves a key (BasicBlock, NodeId, FunctionId, etc.) to its owning
 *  Function via the runtime `ProgramCtx`. The cast is safe because Worklist
 *  always constructs `ProgramCtx` for transfer and subscription callbacks;
 *  the framework's generic surface just does not promise that capability. */
export type FunctionResolver<K> = (ctx: AnalysisCtx, key: K) => Function | undefined;

export const functionOfBlock: FunctionResolver<BasicBlock> = (ctx, block) =>
  asProgramCtx(ctx).functions.get(block.unitId);
export const functionOfNodeId: FunctionResolver<NodeId> = (ctx, nodeId) =>
  asProgramCtx(ctx).functionOfNode(nodeId);
export const functionOfFunctionId: FunctionResolver<FunctionId> = (ctx, functionId) =>
  asProgramCtx(ctx).functions.get(functionId);

export function wakeOwningFunction<K>(
  resolveUnit: FunctionResolver<K>,
): (ctx: AnalysisCtx, key: K) => Iterable<Function> {
  return (ctx, key) => {
    const unit = resolveUnit(ctx, key);
    return unit ? [unit] : [];
  };
}
