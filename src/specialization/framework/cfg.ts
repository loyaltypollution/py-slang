// BasicBlock / CFG types + builder.

import { StmtNS } from "../../ast-types";
import type { FunctionUnit } from "./function-unit";

export type BlockId = number;

export interface BasicBlock {
  readonly id: BlockId;
  /** View into the AST's statement arrays; do not mutate. */
  readonly stmts: StmtNS.Stmt[];
  readonly successors: BasicBlock[];
  readonly predecessors: BasicBlock[];
  /** Set by `indexCFG` after `buildCFG`. */
  unit: FunctionUnit;
}

export interface CFG {
  readonly entry: BasicBlock;
  readonly exit: BasicBlock;
  readonly blocks: ReadonlyArray<BasicBlock>;
}

/** Build CFG from a flat stmt list. Single entry/exit; unreachable tails not represented. */
export function buildCFG(body: StmtNS.Stmt[]): CFG {
  let nextId = 0;
  const blocks: BasicBlock[] = [];

  function makeBlock(): BasicBlock {
    const block: BasicBlock = {
      id: nextId++,
      stmts: [],
      successors: [],
      predecessors: [],
      // Populated by indexCFG.
      unit: undefined as unknown as FunctionUnit,
    };
    blocks.push(block);
    return block;
  }

  function addEdge(from: BasicBlock, to: BasicBlock): void {
    from.successors.push(to);
    to.predecessors.push(from);
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
          addEdge(current, trueBlock);
          const afterTrue = emitBlock(ifStmt.body, trueBlock);

          if (ifStmt.elseBlock) {
            const falseBlock = makeBlock();
            addEdge(current, falseBlock);
            const afterFalse = emitBlock(ifStmt.elseBlock, falseBlock);

            if (afterTrue || afterFalse) {
              const join = makeBlock();
              if (afterTrue) addEdge(afterTrue, join);
              if (afterFalse) addEdge(afterFalse, join);
              current = join;
            } else {
              // Both branches diverge.
              return null;
            }
          } else {
            const join = makeBlock();
            addEdge(current, join);
            if (afterTrue) addEdge(afterTrue, join);
            current = join;
          }
          break;
        }

        case "While": {
          const whileStmt = stmt as StmtNS.While;
          const header = makeBlock();
          addEdge(current, header);
          (header.stmts as StmtNS.Stmt[]).push(stmt);

          const loopBody = makeBlock();
          addEdge(header, loopBody);

          const loopExit = makeBlock();
          addEdge(header, loopExit);

          loopStack.push({ header, exit: loopExit });
          const afterBody = emitBlock(whileStmt.body, loopBody);
          loopStack.pop();

          if (afterBody) addEdge(afterBody, header);

          current = loopExit;
          break;
        }

        case "For": {
          const forStmt = stmt as StmtNS.For;
          const header = makeBlock();
          addEdge(current, header);
          (header.stmts as StmtNS.Stmt[]).push(stmt);

          const loopBody = makeBlock();
          addEdge(header, loopBody);

          const loopExit = makeBlock();
          addEdge(header, loopExit);

          loopStack.push({ header, exit: loopExit });
          const afterBody = emitBlock(forStmt.body, loopBody);
          loopStack.pop();

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
