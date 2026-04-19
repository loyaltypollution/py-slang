// Dead branch elimination. Idempotent: spliced-out `If` nodes no longer match.

import { StmtNS } from "../../ast-types";
import type { BasicBlock } from "../framework/cfg";
import { constAnalysis } from "../framework/dfa-analyses";
import { readExprFact } from "../framework/dfa-factory";
import type { Unit } from "../framework/function-unit";
import { type TransformFactView, unitSweepRule } from "../framework/transform-rule";

class DeadBranchVisitor implements StmtNS.Visitor<void> {
  changed = false;
  constructor(
    private readonly factStore: TransformFactView,
  ) {}

  sweep(stmts: StmtNS.Stmt[]): void {
    let i = 0;
    while (i < stmts.length) {
      const s = stmts[i];
      const replacement = this.tryReplaceIf(s);
      if (replacement !== null) {
        stmts.splice(i, 1, ...replacement);
        this.changed = true;
        // Do not advance i: spliced-in head may itself be a dead `If`.
      } else {
        s.accept(this);
        i++;
      }
    }
  }

  private tryReplaceIf(stmt: StmtNS.Stmt): StmtNS.Stmt[] | null {
    if (!(stmt instanceof StmtNS.If)) return null;
    const cv = readExprFact(
      this.factStore.topology,
      constAnalysis,
      stmt.condition.id,
    );
    if (cv?.tag !== "const" || typeof cv.value !== "boolean") return null;
    return cv.value ? stmt.body : (stmt.elseBlock ?? []);
  }

  visitIfStmt(stmt: StmtNS.If): void {
    this.sweep(stmt.body);
    if (stmt.elseBlock) this.sweep(stmt.elseBlock);
  }
  visitWhileStmt(stmt: StmtNS.While): void {
    this.sweep(stmt.body);
  }
  visitForStmt(stmt: StmtNS.For): void {
    this.sweep(stmt.body);
  }
  visitFileInputStmt(stmt: StmtNS.FileInput): void {
    this.sweep(stmt.statements);
  }
  // Nested functions: own unit handles them.
  visitFunctionDefStmt(_stmt: StmtNS.FunctionDef): void {}
  visitAssignStmt(_stmt: StmtNS.Assign): void {}
  visitAnnAssignStmt(_stmt: StmtNS.AnnAssign): void {}
  visitReturnStmt(_stmt: StmtNS.Return): void {}
  visitSimpleExprStmt(_stmt: StmtNS.SimpleExpr): void {}
  visitAssertStmt(_stmt: StmtNS.Assert): void {}
  visitPassStmt(_stmt: StmtNS.Pass): void {}
  visitBreakStmt(_stmt: StmtNS.Break): void {}
  visitContinueStmt(_stmt: StmtNS.Continue): void {}
  visitGlobalStmt(_stmt: StmtNS.Global): void {}
  visitNonLocalStmt(_stmt: StmtNS.NonLocal): void {}
  visitFromImportStmt(_stmt: StmtNS.FromImport): void {}
}

export const deadBranchRule = unitSweepRule(
  "deadBranchRule",
  (unit: Unit, factStore: TransformFactView) => {
    const v = new DeadBranchVisitor(factStore);
    v.sweep(unit.body);
    return v.changed;
  },
  [{ on: "fact", analysis: constAnalysis.facts, wake: (_ctx, block) => [(block as BasicBlock).unit] }],
);
