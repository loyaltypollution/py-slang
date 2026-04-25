import type { StmtNS } from "../../../ast-types";
import type { NodeId } from "../node-set";
import type { BasicBlock } from "./basic-block";
import type { Function, FunctionId } from "./function";

/** Read-only program-wide lookup surface for the `Function` view kind.
 *
 *  Owned by `FunctionManager`. Consumers that need program-shape lookup
 *  take this as an explicit dependency rather than casting `AnalysisCtx`
 *  to a richer ctx. */
export interface FunctionLocator {
  /** Lookup by FunctionId boundary key (typically `funcAst.id`). */
  functionById(id: FunctionId): Function | undefined;
  /** Lookup by AST scope node — equivalent to `functionById(ast.id)`. The
   *  named overload exists so call sites can document intent (and will
   *  remain correct if the encoding of FunctionId ever changes). */
  functionForAst(ast: StmtNS.FileInput | StmtNS.FunctionDef): Function | undefined;
  /** Resolve the enclosing function that owns `nodeId` in its CFG. */
  functionContainingNode(nodeId: NodeId): Function | undefined;
  /** Resolve the BasicBlock that owns `nodeId`, or undefined if `nodeId`
   *  is not part of any indexed function. */
  blockContaining(nodeId: NodeId): BasicBlock | undefined;
}
