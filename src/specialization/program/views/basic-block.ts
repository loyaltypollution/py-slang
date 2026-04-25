// BasicBlock / CFG types + builder. Branch edges carry the `condition`
// expression for refineOnEdge.
//
// Three-question contract for `BasicBlock`:
//   - materialized: by `buildCFG` during the owning `Function`'s
//                   construction or rebuild (see `wireCFG` in function.ts).
//   - looked up:    by direct reference (e.g. `block.unit`) or via the
//                   owning function's `blockOfNode` / FunctionLocator's
//                   `blockContaining`. Block ids are local to one CFG
//                   build, NOT a stable program-wide identity.
//   - rebuilt:      indirectly, when the owning function rebuilds. Old
//                   block instances are replaced wholesale; consumers
//                   keyed by block reference must evict on
//                   FunctionManager.onRebuild.

import type { ExprNS, StmtNS } from "../../../ast-types";
import type { NodeId } from "../node-set";
import type { Function } from "./function";
import type { View } from "./view";

export type BlockId = number;

export type CFGEdge =
  | { readonly kind: "unconditional"; readonly from: BasicBlock; readonly to: BasicBlock }
  | {
      readonly kind: "branch-true";
      readonly from: BasicBlock;
      readonly to: BasicBlock;
      readonly condition: ExprNS.Expr;
    }
  | {
      readonly kind: "branch-false";
      readonly from: BasicBlock;
      readonly to: BasicBlock;
      readonly condition: ExprNS.Expr;
    };

/** A View — concrete CFG region with exclusive ownership of its `nodeIds`.
 *  Synthetic blocks (entry/exit/joins) have empty `nodeIds` and are not
 *  valid `subscribe` interests. */
export interface BasicBlock extends View {
  readonly id: BlockId;
  readonly stmts: StmtNS.Stmt[];
  readonly successorEdges: CFGEdge[];
  readonly predecessorEdges: CFGEdge[];
  /** Direct reference to the owning Function. Use `unit.funcAst.id` when a
   *  FunctionId boundary key is required (runtime/JIT/observation surfaces). */
  readonly unit: Function;
  readonly nodeIds: Set<NodeId>;
  contains(n: NodeId): boolean;
  readonly size: number;
  iterate(): Iterable<NodeId>;
}

export interface CFG {
  readonly entry: BasicBlock;
  readonly exit: BasicBlock;
  readonly blocks: ReadonlyArray<BasicBlock>;
}

/** Build CFG from a flat stmt list. Single entry/exit. */
export function buildCFG(body: StmtNS.Stmt[], unit: Function): CFG {
  let nextId = 0;
  const blocks: BasicBlock[] = [];

  function makeBlock(): BasicBlock {
    const nodeIds = new Set<NodeId>();
    const block: BasicBlock = {
      id: nextId++,
      stmts: [],
      successorEdges: [],
      predecessorEdges: [],
      unit,
      nodeIds,
      contains: (n) => nodeIds.has(n),
      get size(): number {
        return nodeIds.size;
      },
      iterate: () => nodeIds,
    };
    blocks.push(block);
    return block;
  }

  function linkBlocks(
    from: BasicBlock,
    to: BasicBlock,
    kind: CFGEdge["kind"] = "unconditional",
    condition?: ExprNS.Expr,
  ): void {
    let edge: CFGEdge;
    if (kind === "unconditional") {
      edge = { kind, from, to };
    } else if (condition === undefined) {
      throw new Error(`linkBlocks: ${kind} edge requires a condition`);
    } else {
      edge = { kind, from, to, condition };
    }
    from.successorEdges.push(edge);
    to.predecessorEdges.push(edge);
  }

  const loopStack: { header: BasicBlock; exit: BasicBlock }[] = [];

  const entry = makeBlock();
  const exit = makeBlock();

  /** Emit into `current`; return fall-through block, or null if control diverges. */
  function emitBlock(stmts: StmtNS.Stmt[], current: BasicBlock): BasicBlock | null {
    for (const stmt of stmts) {
      switch (stmt.kind) {
        case "If": {
          const ifStmt = stmt as StmtNS.If;
          current.stmts.push(stmt);

          const trueBlock = makeBlock();
          linkBlocks(current, trueBlock, "branch-true", ifStmt.condition);
          const afterTrue = emitBlock(ifStmt.body, trueBlock);

          if (ifStmt.elseBlock) {
            const falseBlock = makeBlock();
            linkBlocks(current, falseBlock, "branch-false", ifStmt.condition);
            const afterFalse = emitBlock(ifStmt.elseBlock, falseBlock);

            if (!afterTrue && !afterFalse) return null;
            const join = makeBlock();
            if (afterTrue) linkBlocks(afterTrue, join);
            if (afterFalse) linkBlocks(afterFalse, join);
            current = join;
          } else {
            const join = makeBlock();
            linkBlocks(current, join, "branch-false", ifStmt.condition);
            if (afterTrue) linkBlocks(afterTrue, join);
            current = join;
          }
          break;
        }

        case "While":
        case "For": {
          const header = makeBlock();
          linkBlocks(current, header);
          header.stmts.push(stmt);

          // `for` has no narrowable predicate; branch edges carry the
          // iterable as the "condition" placeholder. refineOnEdge ignores
          // non-Compare conditions.
          const condition = stmt.kind === "While"
            ? (stmt as StmtNS.While).condition
            : (stmt as StmtNS.For).iter;
          const body = stmt.kind === "While"
            ? (stmt as StmtNS.While).body
            : (stmt as StmtNS.For).body;

          const loopBody = makeBlock();
          linkBlocks(header, loopBody, "branch-true", condition);

          const loopExit = makeBlock();
          linkBlocks(header, loopExit, "branch-false", condition);

          loopStack.push({ header, exit: loopExit });
          const afterBody = emitBlock(body, loopBody);
          loopStack.pop();

          if (afterBody) linkBlocks(afterBody, header);

          current = loopExit;
          break;
        }

        case "Break": {
          if (loopStack.length === 0) {
            throw new Error("Break outside loop — parser should have rejected this");
          }
          current.stmts.push(stmt);
          linkBlocks(current, loopStack[loopStack.length - 1].exit);
          return null;
        }

        case "Continue": {
          if (loopStack.length === 0) {
            throw new Error("Continue outside loop — parser should have rejected this");
          }
          current.stmts.push(stmt);
          linkBlocks(current, loopStack[loopStack.length - 1].header);
          return null;
        }

        case "Return": {
          current.stmts.push(stmt);
          linkBlocks(current, exit);
          return null;
        }

        default:
          current.stmts.push(stmt);
          break;
      }
    }
    return current;
  }

  const lastBlock = emitBlock(body, entry);
  if (lastBlock) linkBlocks(lastBlock, exit);

  return { entry, exit, blocks };
}
