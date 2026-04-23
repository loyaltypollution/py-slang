// Dead branch elimination. Idempotent: spliced-out `If` nodes no longer match.
//
// Witness-aware: every actual branch prune recovers the shallowest chain that
// proves the condition constant, then publishes at that witness. One sweep can
// therefore materialize ancestor-safe prunes shallow→deep along the active
// future-dispatch lineage.

import { StmtNS } from "../../ast-types";
import type { TransformRule } from "../framework/analysis";
import { unitOfBlock, wakeOwningUnit } from "../framework/analysis";
import type { AssumptionChain } from "../framework/assumption-chain";
import { visibleBody } from "../framework/assumption-bodies";
import { typeAnalysis } from "../framework/dfa-analyses";
import type { Unit } from "../framework/function-unit";
import type { ProgramTopology } from "../framework/topology";
import { BOOL_BIT, BoolRef, TypeLattice } from "../type-analysis/lattice";
import { BaseStmtVisitor, runWitnessSweep } from "./witness-utils";

function boolCondition(
  chain: AssumptionChain,
  topology: ProgramTopology,
  nodeId: number,
) {
  return typeAnalysis
    .perExpr(topology)
    .readMinimal(
      chain,
      nodeId,
      (tv: TypeLattice) =>
        tv.kinds === BOOL_BIT && (tv.boolRef === BoolRef.True || tv.boolRef === BoolRef.False),
    );
}

/** Collect every witness chain that can justify a dead-branch rewrite in the
 *  body currently visible at the sweep chain. */
class SeedFinderVisitor extends BaseStmtVisitor {
  readonly witnesses = new Set<AssumptionChain>();
  constructor(
    private readonly chain: AssumptionChain,
    private readonly topology: ProgramTopology,
  ) {
    super();
  }

  walk(stmts: readonly StmtNS.Stmt[]): void {
    for (const s of stmts) s.accept(this);
  }

  visitIfStmt(stmt: StmtNS.If): void {
    const r = boolCondition(this.chain, this.topology, stmt.condition.id);
    if (r !== undefined) this.witnesses.add(r.witness);
    this.walk(stmt.body);
    if (stmt.elseBlock) this.walk(stmt.elseBlock);
  }
  visitWhileStmt(stmt: StmtNS.While): void {
    this.walk(stmt.body);
  }
  visitForStmt(stmt: StmtNS.For): void {
    this.walk(stmt.body);
  }
  visitFileInputStmt(stmt: StmtNS.FileInput): void {
    this.walk(stmt.statements);
  }
}

class DeadBranchVisitor extends BaseStmtVisitor {
  changed = false;
  constructor(
    private readonly chain: AssumptionChain,
    private readonly topology: ProgramTopology,
  ) {
    super();
  }

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
    const r = boolCondition(this.chain, this.topology, stmt.condition.id);
    if (r === undefined || r.witness !== this.chain) return null;
    return r.value.boolRef === BoolRef.True ? stmt.body : (stmt.elseBlock ?? []);
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
}

export const deadBranchRule: TransformRule = {
  sweep(unit: Unit, chain: AssumptionChain, topology: ProgramTopology): boolean {
    const finder = new SeedFinderVisitor(chain, topology);
    finder.walk(visibleBody(unit, chain));
    return runWitnessSweep(
      unit,
      finder.witnesses,
      (witness) => new DeadBranchVisitor(witness, topology),
    );
  },
  bind(wl) {
    wl.onTransformFactDirty(deadBranchRule, typeAnalysis.facts, wakeOwningUnit(unitOfBlock));
  },
};
