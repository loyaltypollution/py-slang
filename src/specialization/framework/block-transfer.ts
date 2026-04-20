import { ExprNS, StmtNS } from "../../ast-types";
import type { BasicBlock } from "./cfg";
import type { AssumptionChain } from "./context";
import type { BlockPassResult } from "./dfa-factory";
import type { Unit } from "./function-unit";
import type { BlockDfaSpec } from "./interfaces";
import type { MutableEnv } from "./mutable-env";
import { isLocal, type SlotLookup } from "./slot-table";

/** Statement-level transfer; updates `env` in place. If/While/For headers evaluate condition/iter only. */
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

export function transferBlock<L>(
  block: BasicBlock,
  inEnv: MutableEnv<L>,
  module: BlockDfaSpec<L>,
  unit: Unit,
  context: AssumptionChain,
): BlockPassResult<L> {
  const outEnv = inEnv.snapshot();
  const exprFacts = new Map<number, L>();
  const recordExprFact = (nodeId: number, val: L): void => {
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
  return { outEnv, exprFacts };
}
