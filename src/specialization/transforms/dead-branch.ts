// src/specialization/transforms/dead-branch.ts
//
// Dead branch elimination (PR-6c). The legacy `DeadBranchEliminationRule`
// class (a `StmtTransformRule` in `worklist.transforms`) has been
// demolished this PR: its match+apply logic now lives inside
// `deadBranchRule.transfer` (see `../framework/migrated-passes.ts`), which
// calls `applyDeadBranchSweep(unit)` below.
//
// Fires whenever `constAnalysisPass` or `structuralPass` produce a
// lattice-change for the unit, plus an explicit initial-converge seed
// from `worklist.processTransform` (same seeding pattern as PR-6a purity).
//
// Idempotence: the `StmtNS.If` match predicate naturally returns false
// once the If has been spliced out of its block — re-entry on an already-
// converged body is a no-op sweep. The top-only `"fired"` lattice adds a
// second gate: rewriting `"fired"` on the same key equals → no onChange →
// no downstream consumer wakes spuriously.

import { StmtNS } from "../../ast-types";
import type { FactStore } from "../framework/fact-store";
import type { ConstLattice } from "../const-analysis/lattice";
import type { FunctionUnit } from "../framework/function-unit";
import { constAnalysisPass } from "../framework/migrated-passes";

/** Does this `if`-stmt have a statically-known boolean condition? */
function matchesIf(stmt: StmtNS.Stmt, factStore: FactStore): stmt is StmtNS.If {
  if (!(stmt instanceof StmtNS.If)) return false;
  const cv = factStore.tryRead(constAnalysisPass,stmt.condition.id);
  return cv?.tag === "const" && typeof cv.value === "boolean";
}

/** Replace an `if <const bool>:` with the taken branch body. */
function applyIf(ifStmt: StmtNS.If, factStore: FactStore): StmtNS.Stmt[] {
  const cv = factStore.tryRead(constAnalysisPass,ifStmt.condition.id) as ConstLattice & { tag: "const" };
  return cv.value ? ifStmt.body : (ifStmt.elseBlock ?? []);
}

/**
 * Walk `stmts` bottom-up, splicing any `If` whose condition has a known
 * boolean constVal. Mirrors the statement-level traversal of
 * `applyTransformPass` but inlined so we can drop the legacy
 * `StmtTransformRule` interface for this transform.
 *
 * Returns `true` iff at least one splice occurred.
 */
class DeadBranchVisitor implements StmtNS.Visitor<void> {
  changed = false;
  constructor(private readonly factStore: FactStore) {}

  sweep(stmts: StmtNS.Stmt[]): void {
    let i = 0;
    while (i < stmts.length) {
      const s = stmts[i];
      if (matchesIf(s, this.factStore)) {
        const replacements = applyIf(s, this.factStore);
        stmts.splice(i, 1, ...replacements);
        this.changed = true;
        // Do not advance i: inspect the newly spliced-in head as the
        // replacement body may itself contain a dead `If`.
      } else {
        s.accept(this);
        i++;
      }
    }
  }

  visitIfStmt(stmt: StmtNS.If): void {
    // Expression rewrites happen elsewhere — no recursion into stmt.condition.
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
  // Function bodies are optimised independently by their own units.
  visitFunctionDefStmt(_stmt: StmtNS.FunctionDef): void {}
  // Leaves & stmts without child blocks.
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

/**
 * Sweep `unit.body` for `if <const bool>:` statements and splice them
 * out. Returns `true` iff a mutation occurred. Called from
 * `deadBranchRule.transfer`; the worklist marks the scope structurally
 * dirty and bumps the `structuralPass` version when this returns `true`.
 */
export function applyDeadBranchSweep(unit: FunctionUnit, factStore: FactStore): boolean {
  const v = new DeadBranchVisitor(factStore);
  v.sweep(unit.body);
  return v.changed;
}
