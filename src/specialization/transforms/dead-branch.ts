// Dead branch elimination. Idempotent: spliced-out `If` nodes no longer match.
//
// Context-aware: the rule reads const facts via `chain.readExprFactMinimal`
// from the sweep's bound chain, uses the first match to obtain a fork at
// that chain via `chain.forkBody`, then mutates the forked tree. Under ROOT
// this is equivalent to the previous shared-AST rewrite; under a non-ROOT
// chain it prunes branches whose condition is proven const only under
// speculation.

import { StmtNS } from "../../ast-types";
import type { BasicBlock } from "../framework/cfg";
import type { AssumptionChain } from "../framework/context";
import { constAnalysis } from "../framework/dfa-analyses";
import type { Unit } from "../framework/function-unit";
import type { ProgramTopology } from "../framework/topology";
import type { Reading, TransformRule } from "../framework/analysis";
import type { ConstLattice } from "../const-analysis/lattice";

type ConstReading = Reading<ConstLattice>;

function constTruthReading(
  chain: AssumptionChain,
  topology: ProgramTopology,
  nodeId: number,
): ConstReading | undefined {
  return chain.readExprFactMinimal(
    topology,
    constAnalysis,
    nodeId,
    cv => cv.tag === "const" && typeof cv.value === "boolean",
  );
}

/** Scan for the first If whose condition reads as a const boolean. The
 *  returned Reading seeds `chain.forkBody` so the sweep can fork before
 *  mutating. Returns undefined when no Ifs in this unit have const
 *  conditions — the rule then reports "no changes" without touching the
 *  body store. */
function findSeedReading(
  chain: AssumptionChain,
  topology: ProgramTopology,
  stmts: readonly StmtNS.Stmt[],
): ConstReading | undefined {
  for (const s of stmts) {
    if (s instanceof StmtNS.If) {
      const r = constTruthReading(chain, topology, s.condition.id);
      if (r !== undefined) return r;
      const inBody = findSeedReading(chain, topology, s.body);
      if (inBody !== undefined) return inBody;
      if (s.elseBlock) {
        const inElse = findSeedReading(chain, topology, s.elseBlock);
        if (inElse !== undefined) return inElse;
      }
    } else if (s instanceof StmtNS.While || s instanceof StmtNS.For) {
      const inBody = findSeedReading(chain, topology, s.body);
      if (inBody !== undefined) return inBody;
    }
  }
  return undefined;
}

class DeadBranchVisitor implements StmtNS.Visitor<void> {
  changed = false;
  constructor(
    private readonly chain: AssumptionChain,
    private readonly topology: ProgramTopology,
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
    const r = constTruthReading(this.chain, this.topology, stmt.condition.id);
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

export const deadBranchRule: TransformRule = {
  debugName: "deadBranchRule",
  sweep(unit: Unit, chain: AssumptionChain, topology: ProgramTopology): boolean {
    const seed = findSeedReading(chain, topology, unit.body);
    if (seed === undefined) return false;
    const body = chain.forkBody(unit, seed);
    const v = new DeadBranchVisitor(chain, topology);
    v.sweep(body);
    return v.changed;
  },
  bind(wl) {
    wl.onTransformFactDirty(deadBranchRule, constAnalysis.facts,
      (_ctx, block) => [(block as BasicBlock).unit]);
  },
};
