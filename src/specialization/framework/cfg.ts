// src/specialization/framework/cfg.ts — BasicBlock / CFG types + builder

import { StmtNS } from "../../ast-types";
import type { FunctionUnit } from "./function-unit";

// ── Types ────────────────────────────────────────────────────────────────────

export type BlockId = number;

export interface BasicBlock {
  readonly id: BlockId;
  /** View into the AST's statement arrays. Do not mutate — owned by the AST. */
  readonly stmts: StmtNS.Stmt[];
  readonly successors: BasicBlock[];
  readonly predecessors: BasicBlock[];
  /** Set by `indexCFG` immediately after `buildCFG`. Non-null post-indexing. */
  unit: FunctionUnit;
}

export interface CFG {
  readonly entry: BasicBlock;
  readonly exit: BasicBlock;
  readonly blocks: ReadonlyArray<BasicBlock>;
}

// ── Builder ──────────────────────────────────────────────────────────────────

/**
 * Build a control-flow graph from a flat statement list (function/module body).
 *
 * The resulting CFG has a single entry block and a single exit block.
 * Unreachable code (after both branches of an if return, or after break/continue/return)
 * is not represented — no block is created for it.
 *
 * Block ID counter and helper are local to each invocation (no module-global state).
 */
export function buildCFG(body: StmtNS.Stmt[]): CFG {
  let nextId = 0;
  const blocks: BasicBlock[] = [];

  function makeBlock(): BasicBlock {
    const block: BasicBlock = {
      id: nextId++,
      stmts: [],
      successors: [],
      predecessors: [],
      // Populated by indexCFG; cast keeps the field non-optional for callers.
      unit: undefined as unknown as FunctionUnit,
    };
    blocks.push(block);
    return block;
  }

  function addEdge(from: BasicBlock, to: BasicBlock): void {
    from.successors.push(to);
    to.predecessors.push(from);
  }

  // Loop context for break/continue targeting
  const loopStack: { header: BasicBlock; exit: BasicBlock }[] = [];

  const entry = makeBlock();
  const exit = makeBlock();

  /**
   * Emit statements into `current` block, creating new blocks for control flow.
   * Returns the block where control falls through after the last statement,
   * or `null` if control never reaches the end (return/break/continue/diverging if).
   */
  function emitBlock(stmts: StmtNS.Stmt[], current: BasicBlock): BasicBlock | null {
    for (const stmt of stmts) {
      // If a previous statement killed control flow, remaining stmts are dead code.
      // We don't create blocks for them.
      switch (stmt.kind) {
        case "If": {
          const ifStmt = stmt as StmtNS.If;
          // The condition is evaluated in the current block.
          (current.stmts as StmtNS.Stmt[]).push(stmt);

          const trueBlock = makeBlock();
          addEdge(current, trueBlock);
          const afterTrue = emitBlock(ifStmt.body, trueBlock);

          if (ifStmt.elseBlock) {
            const falseBlock = makeBlock();
            addEdge(current, falseBlock);
            const afterFalse = emitBlock(ifStmt.elseBlock, falseBlock);

            // Join point: only create if at least one branch falls through.
            if (afterTrue || afterFalse) {
              const join = makeBlock();
              if (afterTrue) addEdge(afterTrue, join);
              if (afterFalse) addEdge(afterFalse, join);
              current = join;
            } else {
              // Both branches diverge — no fall-through. Remaining stmts are dead.
              return null;
            }
          } else {
            // No else: current → trueBlock, current → join (fall-through).
            const join = makeBlock();
            addEdge(current, join);
            if (afterTrue) addEdge(afterTrue, join);
            current = join;
          }
          break;
        }

        case "While": {
          const whileStmt = stmt as StmtNS.While;
          // Loop header: evaluates condition each iteration.
          const header = makeBlock();
          addEdge(current, header);
          (header.stmts as StmtNS.Stmt[]).push(stmt);

          const loopBody = makeBlock();
          addEdge(header, loopBody);

          const loopExit = makeBlock();
          addEdge(header, loopExit); // condition-false edge

          loopStack.push({ header, exit: loopExit });
          const afterBody = emitBlock(whileStmt.body, loopBody);
          loopStack.pop();

          // Back edge
          if (afterBody) addEdge(afterBody, header);

          current = loopExit;
          break;
        }

        case "For": {
          const forStmt = stmt as StmtNS.For;
          // Loop header: evaluates iter, assigns target each iteration.
          const header = makeBlock();
          addEdge(current, header);
          (header.stmts as StmtNS.Stmt[]).push(stmt);

          const loopBody = makeBlock();
          addEdge(header, loopBody);

          const loopExit = makeBlock();
          addEdge(header, loopExit); // exhaustion edge

          loopStack.push({ header, exit: loopExit });
          const afterBody = emitBlock(forStmt.body, loopBody);
          loopStack.pop();

          // Back edge
          if (afterBody) addEdge(afterBody, header);

          current = loopExit;
          break;
        }

        case "Break": {
          if (loopStack.length === 0) {
            throw new Error("Break outside loop — parser should have rejected this");
          }
          (current.stmts as StmtNS.Stmt[]).push(stmt);
          addEdge(current, loopStack[loopStack.length - 1].exit);
          return null;
        }

        case "Continue": {
          if (loopStack.length === 0) {
            throw new Error("Continue outside loop — parser should have rejected this");
          }
          (current.stmts as StmtNS.Stmt[]).push(stmt);
          addEdge(current, loopStack[loopStack.length - 1].header);
          return null;
        }

        case "Return": {
          (current.stmts as StmtNS.Stmt[]).push(stmt);
          addEdge(current, exit);
          return null;
        }

        // Straight-line statements: append to current block.
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
    addEdge(lastBlock, exit);
  }

  return { entry, exit, blocks };
}
