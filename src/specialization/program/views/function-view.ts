import type { Function } from "./function";
import type { NodeId } from "../node-set";

/** `FunctionDef.id` or `FileInput.id` (alias of NodeId, semantic only).
 *
 *  A `FunctionDef` id has two legitimate meanings:
 *    - `functions.get(id)` resolves the function-view rooted at that node.
 *    - `functionOfNode(id)` resolves the enclosing function that owns the
 *      FunctionDef statement in its CFG.
 *  Keep that distinction explicit at call sites. */
export type FunctionId = NodeId;

/** Read-only program-wide function-view index. This is the program-shape
 *  capability exposed through `ProgramCtx`; generic framework dispatch should
 *  not depend on it. */
export interface FunctionView {
  readonly functions: ReadonlyMap<FunctionId, Function>;
  functionOfNode(nodeId: NodeId): Function | undefined;
}
