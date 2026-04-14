import { ExprNS, StmtNS } from "../../ast-types";
import type { BasicBlock } from "./cfg";
import type { FactStore } from "./fact-store";
import type { AnalysisPass } from "./interfaces";
import type { MutableEnv } from "./mutable-env";
import type { SlotLookup } from "./slot-table";

/** Statement-level transfer; updates `env` in place. If/While/For headers evaluate condition/iter only. */
export function transferStmt<L>(
  stmt: StmtNS.Stmt,
  env: MutableEnv<L>,
  visitor: ExprNS.Visitor<L>,
  module: AnalysisPass<L>,
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
      if (!info.isPrimitive && info.envLevel === 0) env.set(info.slot, module.top());
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
  module: AnalysisPass<L>,
  factStore: FactStore,
  slotLookup: SlotLookup,
): MutableEnv<L> {
  const env = inEnv.snapshot();
  const visitor = module.makeExprVisitor(factStore, env, slotLookup);
  const stmts = block.stmts;
  if (module.direction === "backward") {
    for (let i = stmts.length - 1; i >= 0; i--) {
      transferStmt(stmts[i], env, visitor, module, slotLookup);
    }
  } else {
    for (const stmt of stmts) {
      transferStmt(stmt, env, visitor, module, slotLookup);
    }
  }
  return env;
}
