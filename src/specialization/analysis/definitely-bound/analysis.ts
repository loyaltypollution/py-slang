// Forward + must "definitely-bound locals". Transfer binds at Assign/AnnAssign
// target, For target, and FunctionDef name. Branch conditions don't refine
// boundness: `if x == 10` tells us nothing about whether x is bound.
// `MutableEnv.meetWith` treats absent slots as top, so seedEnv writes every
// slot at entry and transfer never clears.

import { ExprNS, StmtNS } from "../../../ast-types";
import type { Token } from "../../../tokenizer";
import { isLocal, type SlotLookup } from "../../program/units/function/slot-table";
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
    seedEnv: (unit) => {
      const paramCount =
        unit.funcAst instanceof StmtNS.FunctionDef
          ? unit.funcAst.parameters.length
          : 0;
      const env = new MutableEnv<BoundStatus>();
      for (let i = 0; i < unit.slotLookup.slotCount; i++) {
        env.set(i, i < paramCount ? BOUND : UNBOUND);
      }
      return env;
    },
    transferBlock: (_ctx, block, inEnv, unit) => {
      const outEnv = inEnv.snapshot();
      for (const stmt of block.stmts) {
        if (stmt instanceof StmtNS.Assign) {
          if (stmt.target instanceof ExprNS.Variable) {
            bindSlot(outEnv, unit.slotLookup, stmt.target.name);
          }
        } else if (stmt instanceof StmtNS.AnnAssign) {
          bindSlot(outEnv, unit.slotLookup, stmt.target.name);
        } else if (stmt instanceof StmtNS.For) {
          bindSlot(outEnv, unit.slotLookup, stmt.target);
        } else if (stmt instanceof StmtNS.FunctionDef) {
          bindSlot(outEnv, unit.slotLookup, stmt.name);
        }
      }
      return { outEnv, exprFacts: new Map() };
    },
  });
