// Forward + must "definitely-bound locals". Transfer binds at Assign/AnnAssign
// target, For target, and FunctionDef name. Branch conditions don't refine
// boundness: `if x == 10` tells us nothing about whether x is bound.
// `MutableEnv.meetWith` treats absent slots as top, so seedEnv writes every
// slot at entry and transfer never clears.

import { ExprNS, StmtNS } from "../../../ast-types";
import type { Token } from "../../../tokenizer";
import { isLocal, type SlotLookup } from "../../program/function/slot-table";
import { MutableEnv } from "../block-env";
import {
  makeBlockFixpointAnalysis,
  type BlockFixpointAnalysis,
} from "../dfa-factory";
import { BOUND, UNBOUND, boundLattice, type BoundStatus } from "./lattice";

function bindSlot(
  env: MutableEnv<BoundStatus>,
  slotLookup: SlotLookup,
  name: Token,
): void {
  const info = slotLookup(name);
  if (isLocal(info)) env.set(info.slot, BOUND);
}

export const definitelyBoundAnalysis: BlockFixpointAnalysis<BoundStatus> =
  makeBlockFixpointAnalysis<BoundStatus>({
    direction: "forward",
    mergeKind: "must",
    valueLattice: boundLattice,
    seedEnv: (function) => {
      const paramCount =
        function.funcAst instanceof StmtNS.FunctionDef
          ? function.funcAst.parameters.length
          : 0;
      const env = new MutableEnv<BoundStatus>();
      for (let i = 0; i < function.slotLookup.slotCount; i++) {
        env.set(i, i < paramCount ? BOUND : UNBOUND);
      }
      return env;
    },
    transferBlock: (_ctx, block, inEnv, function) => {
      const outEnv = inEnv.snapshot();
      for (const stmt of block.stmts) {
        if (stmt instanceof StmtNS.Assign) {
          if (stmt.target instanceof ExprNS.Variable) {
            bindSlot(outEnv, function.slotLookup, stmt.target.name);
          }
        } else if (stmt instanceof StmtNS.AnnAssign) {
          bindSlot(outEnv, function.slotLookup, stmt.target.name);
        } else if (stmt instanceof StmtNS.For) {
          bindSlot(outEnv, function.slotLookup, stmt.target);
        } else if (stmt instanceof StmtNS.FunctionDef) {
          bindSlot(outEnv, function.slotLookup, stmt.name);
        }
      }
      return { outEnv, exprFacts: new Map() };
    },
  });
