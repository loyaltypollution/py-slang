// BasicBlock / CFG types + builder. Edges are first-class values:
// branch edges carry the `condition` expression for refineOnEdge.

import type { ExprNS, StmtNS } from "../../ast-types";
import type { NodeId } from "./node-set";
import type { FunctionId } from "./program-view";
import type { Function } from "./function";

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

export interface BasicBlock {
  readonly id: BlockId;
  /** View into the AST's statement arrays; do not mutate. */
  readonly stmts: StmtNS.Stmt[];
  readonly successorEdges: CFGEdge[];
  readonly predecessorEdges: CFGEdge[];
  /** Id of the function-view that owns this block. Resolve to the
   *  `Function` via the function-view-manager (`view.functions.get(unitId)`).
   *  An opaque numeric tag, not a typed back-pointer — blocks are pure
   *  NodeSets; ownership is data, not structure. */
  readonly unitId: FunctionId;
  /** Node ids owned by this block. Populated by `wireCFG`. Backs both
   *  `contains` (membership) and the `NodeSet` iteration contract. */
  readonly nodeIds: Set<NodeId>;
  /** NodeSet conformance: O(1) via this block's own `nodeIds` set. */
  contains(n: NodeId): boolean;
  /** NodeSet conformance: cardinality of `nodeIds`. */
  readonly size: number;
  /** NodeSet conformance: iterate this block's node ids. */
  iterate(): Iterable<NodeId>;
}

export interface CFG {
  readonly entry: BasicBlock;
  readonly exit: BasicBlock;
  readonly blocks: ReadonlyArray<BasicBlock>;
}

/** Build CFG from a flat stmt list. Single entry/exit; unreachable tails
 *  not represented. */
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
      unitId: unit.funcAst.id,
      nodeIds,
      contains(n: NodeId): boolean {
        return nodeIds.has(n);
      },
      get size(): number {
        return nodeIds.size;
      },
      iterate(): Iterable<NodeId> {
        return nodeIds;
      },
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
          (current.stmts as StmtNS.Stmt[]).push(stmt);

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
          (header.stmts as StmtNS.Stmt[]).push(stmt);

          // `for` has no narrowable predicate; branch edges carry the
          // iterable as the "condition" placeholder. refineOnEdge should
          // ignore non-Compare conditions.
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
          (current.stmts as StmtNS.Stmt[]).push(stmt);
          linkBlocks(current, loopStack[loopStack.length - 1].exit);
          return null;
        }

        case "Continue": {
          if (loopStack.length === 0) {
            throw new Error("Continue outside loop — parser should have rejected this");
          }
          (current.stmts as StmtNS.Stmt[]).push(stmt);
          linkBlocks(current, loopStack[loopStack.length - 1].header);
          return null;
        }

        case "Return": {
          (current.stmts as StmtNS.Stmt[]).push(stmt);
          linkBlocks(current, exit);
          return null;
        }

        default:
          (current.stmts as StmtNS.Stmt[]).push(stmt);
          break;
      }
    }
    return current;
  }

  const lastBlock = emitBlock(body, entry);
  if (lastBlock) linkBlocks(lastBlock, exit);

  return { entry, exit, blocks };
}
