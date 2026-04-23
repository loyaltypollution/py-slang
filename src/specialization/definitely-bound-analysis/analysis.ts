// Forward + must: "definitely-bound locals."
//
// Companion to the framework tutorial's §13 four-quadrant claim. Until this
// analysis landed, the in-tree corpus exercised three of the four classical
// DFA quadrants (forward/may, backward/may, backward/must); this fills the
// forward/must corner so the framework's quadrant-symmetry claim has a
// concrete witness, not just a type-system argument.
//
// Semantics. At each program point we track, per local slot, whether the
// slot is bound on every path from function entry. Entry seeds parameter
// slots as `bound` and the remaining locals as `unbound`. Transfer:
//
//   - `x = e`        ⇒ slot(x) := BOUND
//   - `x: T = e`     ⇒ slot(x) := BOUND
//   - `for x in ...` ⇒ slot(x) := BOUND      (loop iterator is bound in body)
//   - all others     ⇒ no change
//
// Merge at CFG joins is pointwise meet on the per-slot lattice: if any
// predecessor says `unbound`, the merge says `unbound`. The shape-level
// consumer of this analysis is a future transform that elides CPython-style
// "unbound local" checks at reads whose slot is definitely bound.
//
// Implementation note — the seed must initialize every slot. `MutableEnv`'s
// `meetWith` treats absent-slot sides as `top` (= BOUND here), which is fine
// for analyses whose semantic top is "no constraint" (e.g.
// typeRequirementAnalysis) but collides with definitely-bound's
// "unbound/unknown" default. The fix is to make every slot explicitly
// present at entry (via `slotLookup.slotCount`) and to never `clear` a slot
// during transfer — only `set` it to an explicit status. That keeps merges
// in the "both sides present" branch of `meetWith`, where the lattice's
// `meet` is called directly.

import { ExprNS, StmtNS } from "../../ast-types";
import type { BasicBlock } from "../framework/cfg";
import {
  makeBlockFixpointAnalysis,
  type BlockFixpointAnalysis,
  type BlockPassResult,
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

function transferStmtForward(
  stmt: StmtNS.Stmt,
  env: MutableEnv<BoundStatus>,
  slotLookup: SlotLookup,
): void {
  switch (stmt.kind) {
    case "Assign": {
      const a = stmt as StmtNS.Assign;
      if (a.target instanceof ExprNS.Variable) bindSlot(env, slotLookup, a.target.name);
      return;
    }
    case "AnnAssign":
      bindSlot(env, slotLookup, (stmt as StmtNS.AnnAssign).target.name);
      return;
    case "For":
      bindSlot(env, slotLookup, (stmt as StmtNS.For).target);
      return;
    case "FunctionDef":
      // A `def name(...)` binds `name` in the enclosing scope.
      bindSlot(env, slotLookup, (stmt as StmtNS.FunctionDef).name);
      return;
    default:
      return;
  }
}

function transferBlockForward(
  block: BasicBlock,
  inEnv: MutableEnv<BoundStatus>,
  slotLookup: SlotLookup,
): BlockPassResult<BoundStatus> {
  const outEnv = inEnv.snapshot();
  for (const stmt of block.stmts) {
    transferStmtForward(stmt, outEnv, slotLookup);
  }
  return { outEnv, exprFacts: new Map() };
}

/** Forward + must block DFA: "is this slot bound on every path to here?"
 *
 *  The `.env` cell stores the block's OUT-env; read per-slot via
 *  `definitelyBoundAnalysis.env.read(block, ROOT_CONTEXT).get(slot)`. A
 *  missing binding at the read site would indicate a seeding bug (the
 *  invariant is that every slot is always present); callers should treat
 *  that as an internal error rather than "unbound." */
export const definitelyBoundAnalysis: BlockFixpointAnalysis<BoundStatus> =
  makeBlockFixpointAnalysis<BoundStatus>({
    direction: "forward",
    mergeKind: "must",
    valueLattice: boundLattice,
    seedEnv: (unit) => {
      const env = new MutableEnv<BoundStatus>();
      const paramCount =
        unit.funcAst instanceof StmtNS.FunctionDef
          ? unit.funcAst.parameters.length
          : 0;
      const totalSlots = unit.slotLookup.slotCount;
      for (let i = 0; i < paramCount; i++) env.set(i, BOUND);
      for (let i = paramCount; i < totalSlots; i++) env.set(i, UNBOUND);
      return env;
    },
    transferBlock: (_ctx, block, inEnv, unit) =>
      transferBlockForward(block, inEnv, unit.slotLookup),
    // No branch-condition narrowing: an `if x == 10` does not tell us
    // whether x is bound on the taken edge — the guard already assumes
    // access. Identity on both edges.
    refineOnEdge: (env, _edge) => env,
  });
