// BasicBlock / CFG types + builder.
//
// Edges are first-class values: a `CFGEdge` carries `from`, `to`, a `kind`
// discriminant, and (for branch edges) the `condition` expression whose
// truth value the edge reflects. Analysis analyses that implement
// `refineOnEdge` read `condition` to narrow the env at merge sites.
//
// Iterate `block.successorEdges` / `block.predecessorEdges` to traverse.
// The legacy array-of-block views (`successors` / `predecessors`) were
// removed once the last consumer migrated.

import type { ExprNS, StmtNS } from "../../ast-types";
import type { Unit } from "./function-unit";

export type BlockId = number;

/** Control-flow edge between two blocks. The `kind` tag parallels
 *  `EdgeSpec.on` in the scheduling layer: `"unconditional"` is the
 *  structural default, the two `"branch-*"` variants carry the condition
 *  whose truth value the edge reflects. Readers that don't care about the
 *  condition treat all three uniformly via `from`/`to`. */
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
  /** Outgoing control-flow edges. */
  readonly successorEdges: CFGEdge[];
  /** Incoming control-flow edges. */
  readonly predecessorEdges: CFGEdge[];
  /** Back-pointer to owning unit; set by `buildCFG` at creation. */
  readonly unit: Unit;
}

export interface CFG {
  readonly entry: BasicBlock;
  readonly exit: BasicBlock;
  readonly blocks: ReadonlyArray<BasicBlock>;
}

/** Build CFG from a flat stmt list. Single entry/exit; unreachable tails not represented.
 *  `unit` is the owning Unit; every block's `unit` back-pointer is set at creation. */
export function buildCFG(body: StmtNS.Stmt[], unit: Unit): CFG {
  let nextId = 0;
  const blocks: BasicBlock[] = [];

  function makeBlock(): BasicBlock {
    const block: BasicBlock = {
      id: nextId++,
      stmts: [],
      successorEdges: [],
      predecessorEdges: [],
      unit,
    };
    blocks.push(block);
    return block;
  }

  /** Create a labeled edge between two blocks. Callers supply the edge `kind`
   *  and (when the kind demands it) the `condition` expression. */
  function linkBlocks(
    from: BasicBlock,
    to: BasicBlock,
    kind: CFGEdge["kind"] = "unconditional",
    condition?: ExprNS.Expr,
  ): void {
    let edge: CFGEdge;
    if (kind === "unconditional") {
      edge = { kind, from, to };
    } else {
      if (condition === undefined) {
        throw new Error(`linkBlocks: ${kind} edge requires a condition`);
      }
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

            if (afterTrue || afterFalse) {
              const join = makeBlock();
              if (afterTrue) linkBlocks(afterTrue, join);
              if (afterFalse) linkBlocks(afterFalse, join);
              current = join;
            } else {
              // Both branches diverge.
              return null;
            }
          } else {
            const join = makeBlock();
            linkBlocks(current, join, "branch-false", ifStmt.condition);
            if (afterTrue) linkBlocks(afterTrue, join);
            current = join;
          }
          break;
        }

        case "While": {
          const whileStmt = stmt as StmtNS.While;
          const header = makeBlock();
          linkBlocks(current, header);
          (header.stmts as StmtNS.Stmt[]).push(stmt);

          const loopBody = makeBlock();
          linkBlocks(header, loopBody, "branch-true", whileStmt.condition);

          const loopExit = makeBlock();
          linkBlocks(header, loopExit, "branch-false", whileStmt.condition);

          loopStack.push({ header, exit: loopExit });
          const afterBody = emitBlock(whileStmt.body, loopBody);
          loopStack.pop();

          if (afterBody) linkBlocks(afterBody, header);

          current = loopExit;
          break;
        }

        case "For": {
          const forStmt = stmt as StmtNS.For;
          const header = makeBlock();
          linkBlocks(current, header);
          (header.stmts as StmtNS.Stmt[]).push(stmt);

          // `for` has no narrowable predicate; branch edges carry the
          // iterable expression as the "condition" purely as a placeholder.
          // Analyses that implement `refineOnEdge` should ignore non-Compare
          // conditions.
          const loopBody = makeBlock();
          linkBlocks(header, loopBody, "branch-true", forStmt.iter);

          const loopExit = makeBlock();
          linkBlocks(header, loopExit, "branch-false", forStmt.iter);

          loopStack.push({ header, exit: loopExit });
          const afterBody = emitBlock(forStmt.body, loopBody);
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

        default: {
          (current.stmts as StmtNS.Stmt[]).push(stmt);
          break;
        }
      }
    }
    return current;
  }

  const lastBlock = emitBlock(body, entry);
  if (lastBlock) {
    linkBlocks(lastBlock, exit);
  }

  return { entry, exit, blocks };
}
