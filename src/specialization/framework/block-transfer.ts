import { ExprNS, StmtNS } from "../../ast-types";
import type { BasicBlock } from "./cfg";
import type { MutableEnv } from "./mutable-env";
import type { SlotLookup } from "./slot-table";

/**
 * Direction of a CFG transfer pass over a block's statements.
 */
export type TransferDirection = "forward" | "backward";

/**
 * Statement-level transfer. Updates `env` in place. Control-flow stmts
 * (If/While/For) appear as headers in their own block; only the
 * condition/iter is evaluated here — bodies live in successor blocks.
 *
 * `top` is the lattice element written into the For-loop target slot
 * (its iteration value cannot be statically narrowed).
 */
export function transferStmt<L>(
  stmt: StmtNS.Stmt,
  env: MutableEnv<L>,
  visitor: ExprNS.Visitor<L>,
  top: L,
  slotLookup: SlotLookup,
): void {
  switch (stmt.kind) {
    case "Assign": {
      const a = stmt as StmtNS.Assign;
      const val = a.value.accept(visitor);
      if (!(a.target instanceof ExprNS.Variable)) return;
      const info = slotLookup(a.target.name);
      if (!info.isPrimitive && info.envLevel === 0) env.set(info.slot, val);
      return;
    }
    case "AnnAssign": {
      const a = stmt as StmtNS.AnnAssign;
      const val = a.value.accept(visitor);
      const info = slotLookup(a.target.name);
      if (!info.isPrimitive && info.envLevel === 0) env.set(info.slot, val);
      return;
    }
    case "If":
      (stmt as StmtNS.If).condition.accept(visitor);
      return;
    case "While":
      (stmt as StmtNS.While).condition.accept(visitor);
      return;
    case "For": {
      const f = stmt as StmtNS.For;
      f.iter.accept(visitor);
      const info = slotLookup(f.target);
      if (!info.isPrimitive && info.envLevel === 0) env.set(info.slot, top);
      return;
    }
    case "Return": {
      const r = stmt as StmtNS.Return;
      if (r.value) r.value.accept(visitor);
      return;
    }
    case "SimpleExpr":
      (stmt as StmtNS.SimpleExpr).expression.accept(visitor);
      return;
    case "Assert":
      (stmt as StmtNS.Assert).value.accept(visitor);
      return;
    case "FunctionDef":
    case "Pass":
    case "Break":
    case "Continue":
    case "Global":
    case "NonLocal":
    case "FromImport":
    case "FileInput":
      return;
  }
}

/**
 * Spec describing how to drive a single block's transfer:
 *   - `top`: lattice top (used for For-loop target widening).
 *   - `direction`: forward or backward statement iteration order.
 *   - `makeVisitor`: build the per-statement expression visitor for the
 *     block, given the in-place env and an optional per-node tap. The
 *     visitor closes over any analysis-specific inputs (e.g. observations).
 */
export interface BlockTransferSpec<L> {
  readonly top: L;
  readonly direction: TransferDirection;
  makeVisitor(
    env: { get(slot: number): L | undefined },
    tap: ((id: number, val: L) => void) | undefined,
  ): ExprNS.Visitor<L>;
}

/**
 * Run a block's transfer. Returns the snapshot exit env. If `tap` is
 * provided the visitor emits per-node lattice values to it (used by the
 * runtime per-node projection queries); otherwise no per-node fact
 * publication occurs.
 */
export function transferBlock<L>(
  block: BasicBlock,
  inEnv: MutableEnv<L>,
  spec: BlockTransferSpec<L>,
  slotLookup: SlotLookup,
  tap?: (id: number, val: L) => void,
): MutableEnv<L> {
  const env = inEnv.snapshot();
  const visitor = spec.makeVisitor(env, tap);
  const stmts = block.stmts;
  if (spec.direction === "backward") {
    for (let i = stmts.length - 1; i >= 0; i--) {
      transferStmt(stmts[i], env, visitor, spec.top, slotLookup);
    }
  } else {
    for (const stmt of stmts) {
      transferStmt(stmt, env, visitor, spec.top, slotLookup);
    }
  }
  return env;
}
