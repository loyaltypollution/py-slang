import type { BasicBlock } from "./basic-block";
import type { Function, FunctionId } from "./function";
import type { FunctionLocator } from "./function-locator";
import type { NodeId } from "../node-set";

/** Resolves a key (BasicBlock, NodeId, FunctionId, etc.) to its owning
 *  Function via a `FunctionLocator`. The narrow ctx-free signature is the
 *  Phase-3 replacement for the old `(AnalysisCtx, key) → Function` shape:
 *  observation/narrowing bindings declared a unit-resolver to participate in
 *  the worklist's per-source dispatch, and that did not need full ctx
 *  capability — only program-shape lookup. */
export type FunctionResolver<K> = (locator: FunctionLocator, key: K) => Function | undefined;

export const functionOfBlock: FunctionResolver<BasicBlock> = (_locator, block) => block.unit;
export const functionOfNodeId: FunctionResolver<NodeId> = (locator, nodeId) =>
  locator.functionContainingNode(nodeId);
export const functionOfFunctionId: FunctionResolver<FunctionId> = (locator, id) =>
  locator.functionById(id);

export function wakeOwningFunction<K>(
  resolveUnit: FunctionResolver<K>,
): (locator: FunctionLocator, key: K) => Iterable<Function> {
  return (locator, key) => {
    const unit = resolveUnit(locator, key);
    return unit ? [unit] : [];
  };
}
