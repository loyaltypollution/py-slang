import { ExprNS, StmtNS } from "../../ast-types";
import type { BasicBlock } from "./cfg";
import type { AssumptionChain } from "../assumption/chain";
import {
  makeBlockFixpointAnalysis,
  type BlockDfaSpec,
  type BlockFixpointAnalysis,
  type BlockPassResult,
} from "./dfa-factory";
import type { Unit } from "./function-unit";
import { EMPTY_MAP } from "./analysis-store";
import { MutableEnv } from "./mutable-env";
import { isLocal, type SlotLookup } from "./slot-table";

/** Statement-level transfer; updates `env` in place. If/While/For headers
 *  evaluate condition/iter only. */
function transferStmt<L>(
  stmt: StmtNS.Stmt,
  env: MutableEnv<L>,
  visitor: ExprNS.Visitor<L>,
  module: BlockDfaSpec<L>,
  slotLookup: SlotLookup,
): void {
  switch (stmt.kind) {
    case "Assign": {
      const a = stmt as StmtNS.Assign;
      const val = a.value.accept(visitor);
      if (!(a.target instanceof ExprNS.Variable)) return;
      const info = slotLookup(a.target.name);
      if (isLocal(info)) env.set(info.slot, val);
      return;
    }
    case "AnnAssign": {
      const a = stmt as StmtNS.AnnAssign;
      const val = a.value.accept(visitor);
      const info = slotLookup(a.target.name);
      if (isLocal(info)) env.set(info.slot, val);
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
      if (isLocal(info)) env.set(info.slot, module.top);
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

/** Compute OUT env + per-node expr facts for `block`. `inEnv` is
 *  caller-owned and mutated in place; callers reusing a live env MUST
 *  snapshot before passing it in. */
function transferBlock<L>(
  block: BasicBlock,
  inEnv: MutableEnv<L>,
  module: BlockDfaSpec<L>,
  unit: Unit,
  context: AssumptionChain,
): BlockPassResult<L> {
  const outEnv = inEnv;
  // Lazy fact-map allocation: most blocks record no per-expr facts.
  let exprFacts: Map<number, L> | undefined;
  const recordExprFact = (nodeId: number, val: L): void => {
    if (exprFacts === undefined) exprFacts = new Map<number, L>();
    exprFacts.set(nodeId, val);
  };
  const slotLookup = unit.slotLookup;
  const visitor = module.makeExprVisitor(outEnv, unit, slotLookup, recordExprFact, context);
  const stmts = block.stmts;
  if (module.direction === "backward") {
    for (let i = stmts.length - 1; i >= 0; i--) {
      transferStmt(stmts[i], outEnv, visitor, module, slotLookup);
    }
  } else {
    for (const stmt of stmts) {
      transferStmt(stmt, outEnv, visitor, module, slotLookup);
    }
  }
  return {
    outEnv,
    exprFacts: exprFacts ?? (EMPTY_MAP as ReadonlyMap<number, L>),
  };
}

/** Adapter from a `BlockDfaSpec` to a `BlockFixpointAnalysis`. The spec IS the
 *  value lattice, provides the expression visitor, and the per-edge refinement;
 *  the factory wiring (empty seed env, statement walker via `transferBlock`,
 *  passthrough `refineOnEdge`) is mechanical and was duplicated across the
 *  const- and type-analysis modules. */
export function blockFixpointFromSpec<L>(
  module: BlockDfaSpec<L>,
): BlockFixpointAnalysis<L> {
  return makeBlockFixpointAnalysis<L>({
    direction: module.direction,
    valueLattice: module,
    mergeKind: module.mergeKind,
    seedEnv: () => new MutableEnv<L>(),
    transferBlock: (ctx, block, inEnv, unit) =>
      transferBlock(block, inEnv, module, unit, ctx.currentContext),
    refineOnEdge: module.refineOnEdge,
  });
}
