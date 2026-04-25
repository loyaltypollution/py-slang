import type { AnalysisCtx } from "../framework/analysis";
import type { BasicBlock } from "./cfg";
import type { Function } from "./function";
import { asProgramCtx } from "./program-ctx";
import type { NodeId } from "./node-set";

export type { NodeId } from "./node-set";
/** `FunctionDef.id` or `FileInput.id` (alias of NodeId, semantic only). */
export type FunctionId = NodeId;

/** Read-only program-wide unit index. `Worklist` is the canonical implementer.
 *  This is the public read surface for consumers that need to enumerate
 *  function-views; the worklist exposes it as the runtime backing of
 *  `ProgramCtx`. */
export interface FunctionView {
  readonly functions: ReadonlyMap<FunctionId, Function>;
  functionOfNode(nodeId: NodeId): Function | undefined;
}

/** Function-entry parameter identity, encoded as `${functionId}:${paramIndex}`
 *  so it is usable directly as a Context/store key. */
export type ParamKey = `${FunctionId}:${number}`;

export function paramKey(functionId: FunctionId, paramIndex: number): ParamKey {
  return `${functionId}:${paramIndex}`;
}

export function paramKeyFunctionId(key: ParamKey): FunctionId {
  return Number(key.slice(0, key.indexOf(":")));
}

export function paramKeyIndex(key: ParamKey): number {
  return Number(key.slice(key.indexOf(":") + 1));
}

/** Resolves a key (BasicBlock, NodeId, FunctionId) to its owning Function via
 *  the function-view-manager handle on the runtime ctx. Takes the framework's
 *  generic `AnalysisCtx` and casts to `ProgramCtx` internally — the cast is
 *  safe at runtime because Worklist always constructs `ProgramCtx` for
 *  transfers; the framework just doesn't promise it in its types. */
export type FunctionResolver<K> = (ctx: AnalysisCtx, key: K) => Function | undefined;

export const functionOfBlock: FunctionResolver<BasicBlock> = (ctx, block) =>
  asProgramCtx(ctx).functions.get(block.unitId);
export const functionOfNodeId: FunctionResolver<NodeId> = (ctx, nodeId) =>
  asProgramCtx(ctx).functionOfNode(nodeId);
export const functionOfFunctionId: FunctionResolver<FunctionId> = (ctx, functionId) =>
  asProgramCtx(ctx).functions.get(functionId);

export function wakeOwningFunction<K>(resolveUnit: FunctionResolver<K>): (ctx: AnalysisCtx, key: K) => Iterable<Function> {
  return (ctx, key) => {
    const unit = resolveUnit(ctx, key);
    return unit ? [unit] : [];
  };
}
