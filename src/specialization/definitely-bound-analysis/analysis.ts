// Forward + must: "definitely-bound locals" — at each program point, is this
// slot bound on every path from entry? Transfer binds slots at `x = e`,
// `x: T = e`, `for x in ...`, and `def x(...)`; CFG-joins are pointwise meet
// (unbound wins on disagreement).
//
// Seeding invariant: every slot must be explicitly present at entry (params
// BOUND, rest UNBOUND), and transfer must only `set` — never `clear`.
// `MutableEnv.meetWith` treats absent-slot sides as `top` (= BOUND), which
// would silently promote unbound locals on merges of partially-seeded envs.

import { ExprNS, StmtNS } from "../../ast-types";
import {
  makeBlockFixpointAnalysis,
  type BlockFixpointAnalysis,
} from "../framework/dfa-factory";
import { MutableEnv } from "../framework/mutable-env";
import { isLocal, type SlotLookup } from "../framework/slot-table";
import { BOUND, UNBOUND, boundLattice, type BoundStatus } from "./lattice";

function bindSlot(
  env: MutableEnv<BoundStatus>,
  slotLookup: SlotLookup,
  name: Parameters<SlotLookup>[0],
): void {
  const info = slotLookup(name);
  if (isLocal(info)) env.set(info.slot, BOUND);
}

/** Forward + must block DFA. `.env` stores the block's OUT-env; read per-slot
 *  via `definitelyBoundAnalysis.env.read(block, chain).get(slot)`. A missing
 *  slot indicates a seeding bug (every slot is always present) — treat as
 *  internal error, not "unbound". */
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
    // No branch-condition narrowing: an `if x == 10` does not tell us
    // whether x is bound on the taken edge — the guard already assumes
    // access. Identity on both edges.
    refineOnEdge: (env, _edge) => env,
  });
