// Dead branch elimination. Idempotent: spliced-out `If` nodes no longer match.
//
// Context-aware: the rule reads const facts via `readExprFactMinimal` from
// the view's bound context, uses the first match to obtain a fork at that
// context via `bodyAtWitness`, then mutates the forked tree. Under ROOT
// this is equivalent to the previous shared-AST rewrite; under a
// non-ROOT view it prunes branches whose condition is proven const only
// under speculation.

import { StmtNS } from "../../ast-types";
import type { BasicBlock } from "../framework/cfg";
import { constAnalysis } from "../framework/dfa-analyses";
import type { Unit } from "../framework/function-unit";
import { type TransformFactView, unitSweepRule } from "../framework/transform-rule";
import type { Reading } from "../framework/analysis";
import type { ConstLattice } from "../const-analysis/lattice";

type ConstReading = Reading<ConstLattice>;

function constTruthReading(
  facts: TransformFactView,
  nodeId: number,
): ConstReading | undefined {
  return facts.readExprFactMinimal(
    constAnalysis,
    nodeId,
    cv => cv.tag === "const" && typeof cv.value === "boolean",
  );
}

/** Scan for the first If whose condition reads as a const boolean. The
 *  returned Reading seeds `bodyAtWitness` so the sweep can fork before
 *  mutating. Returns undefined when no Ifs in this unit have const
 *  conditions — the rule then reports "no changes" without touching the
 *  body store. */
function findSeedReading(
  facts: TransformFactView,
  stmts: readonly StmtNS.Stmt[],
): ConstReading | undefined {
  for (const s of stmts) {
    if (s instanceof StmtNS.If) {
      const r = constTruthReading(facts, s.condition.id);
      if (r !== undefined) return r;
      const inBody = findSeedReading(facts, s.body);
      if (inBody !== undefined) return inBody;
      if (s.elseBlock) {
        const inElse = findSeedReading(facts, s.elseBlock);
        if (inElse !== undefined) return inElse;
      }
    } else if (s instanceof StmtNS.While || s instanceof StmtNS.For) {
      const inBody = findSeedReading(facts, s.body);
      if (inBody !== undefined) return inBody;
    }
  }
  return undefined;
}

class DeadBranchVisitor implements StmtNS.Visitor<void> {
  changed = false;
  constructor(
    private readonly facts: TransformFactView,
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
    const r = constTruthReading(this.facts, stmt.condition.id);
    if (r === undefined) return null;
    const cv = r.value;
    if (cv.tag !== "const" || typeof cv.value !== "boolean") return null;
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
  (unit: Unit, facts: TransformFactView) => {
    const seed = findSeedReading(facts, unit.body);
    if (seed === undefined) return false;
    const body = facts.bodyAtWitness(unit, seed);
    const v = new DeadBranchVisitor(facts);
    v.sweep(body);
    return v.changed;
  },
  [{ on: "fact", analysis: constAnalysis.facts, wake: (_ctx, block) => [(block as BasicBlock).unit] }],
);
