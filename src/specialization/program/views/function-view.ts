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

/** Read-only program-wide function index. NOT a view object — this is a
 *  registry surface (the view objects are `Function` and `BasicBlock`). The
 *  name is historical and is scheduled to change with Phase 3 of the
 *  view-contract refactor (becomes the lookup surface on `FunctionManager`).
 *  Generic framework dispatch should not depend on it. */
export interface FunctionView {
  readonly functions: ReadonlyMap<FunctionId, Function>;
  functionOfNode(nodeId: NodeId): Function | undefined;
}
