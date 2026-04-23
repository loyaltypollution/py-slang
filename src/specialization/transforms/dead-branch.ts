// Dead branch elimination. Idempotent (spliced-out `If` nodes cannot match
// again). Witness-aware: each prune publishes at the shallowest chain that
// proves the condition constant.

import { StmtNS } from "../../ast-types";
import type { TransformRule } from "../framework/analysis";
import { unitOfBlock, wakeOwningUnit } from "../framework/analysis";
import type { AssumptionChain } from "../lattice/chain";
import { visibleBody } from "../assumption/assumption-bodies";
import { typeAnalysis } from "../framework/narrowing-registry";
import type { Unit } from "../framework/function-unit";
import type { ProgramTopology } from "../framework/topology";
import { BOOL_BIT, BoolRef, TypeLattice } from "../type-analysis/lattice";
import { BaseStmtVisitor, runWitnessSweep } from "./witness-utils";

function boolCondition(chain: AssumptionChain, topology: ProgramTopology, nodeId: number) {
  return typeAnalysis
    .perExpr(topology)
    .readMinimal(
      chain,
      nodeId,
      (tv: TypeLattice) =>
        tv.kinds === BOOL_BIT && (tv.boolRef === BoolRef.True || tv.boolRef === BoolRef.False),
    );
}

function collectConstCondWitnesses(
  stmts: readonly StmtNS.Stmt[],
  chain: AssumptionChain,
  topology: ProgramTopology,
  out: Set<AssumptionChain>,
): void {
  for (const s of stmts) {
    if (s instanceof StmtNS.If) {
      const r = boolCondition(chain, topology, s.condition.id);
      if (r !== undefined) out.add(r.witness);
      collectConstCondWitnesses(s.body, chain, topology, out);
      if (s.elseBlock) collectConstCondWitnesses(s.elseBlock, chain, topology, out);
    } else if (s instanceof StmtNS.While || s instanceof StmtNS.For) {
      collectConstCondWitnesses(s.body, chain, topology, out);
    } else if (s instanceof StmtNS.FileInput) {
      collectConstCondWitnesses(s.statements, chain, topology, out);
    }
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
    const witnesses = new Set<AssumptionChain>();
    collectConstCondWitnesses(visibleBody(unit, chain), chain, topology, witnesses);
    return runWitnessSweep(
      unit,
      witnesses,
      (witness) => new DeadBranchVisitor(witness, topology),
    );
  },
  bind(wl) {
    wl.onTransformFactDirty(deadBranchRule, typeAnalysis.facts, wakeOwningUnit(unitOfBlock));
  },
};
