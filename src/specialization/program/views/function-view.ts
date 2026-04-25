import type { Function } from "./function";
import type { NodeId } from "../node-set";

/** `FunctionDef.id` or `FileInput.id` (alias of NodeId, semantic only).
 *
 *  Boundary key — exists for runtime/JIT/observation surfaces (counters,
 *  channels, AssumptionChain bindings, ParamKey) where a stable serialisable
 *  identity is required. NOT a routing/structural key inside the IR; internal
 *  view relations should use a `Function` reference (e.g. `block.unit`) and
 *  reach for a FunctionId only at the boundary, via `unit.funcAst.id`.
 *
 *  A `FunctionDef` id has two legitimate meanings, kept distinct at call sites:
 *    - `functions.get(id)` resolves the function rooted at that node.
 *    - `functionOfNode(id)` resolves the enclosing function that owns the
 *      FunctionDef statement in its CFG. */
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
