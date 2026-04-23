import { StmtNS } from "../../../ast-types";
import { runtimeCallCounter } from "../../../specialization/assumption/runtime-analyses";
import type { Worklist } from "../../../specialization/framework/worklist";

export function findFunctionDef(ast: StmtNS.FileInput, name: string): StmtNS.FunctionDef {
  for (const s of ast.statements) {
    if (s instanceof StmtNS.FunctionDef && s.name.lexeme === name) return s;
  }
  throw new Error(`FunctionDef ${name} not found`);
}

export function observeCallsTo(wl: Worklist, fd: StmtNS.FunctionDef, n: number): void {
  for (let i = 0; i < n; i++) wl.bump(runtimeCallCounter, fd.id);
}
