import { StmtNS } from "../../ast-types";
import type { TransformRule } from "../framework/analysis";
import type { AssumptionChain } from "../assumption/chain";
import { visibleBody } from "../speculation/assumption-bodies";
import type { Function } from "../program/units/function/function";
import type { FunctionLocator } from "../program/units/function/manager";
import { BOOL_BIT, BoolRef, type TypeLattice, typeAnalysis } from "../analysis";
import { BaseStmtVisitor, runWitnessSweep, type Witnessed } from "./witness-utils";

function boolCondition(
  chain: AssumptionChain,
  view: FunctionLocator,
  nodeId: number,
): Witnessed<TypeLattice> | undefined {
  return typeAnalysis
    .perExpr(view)
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
  view: FunctionLocator,
  out: Set<AssumptionChain>,
): void {
  for (const s of stmts) {
    if (s instanceof StmtNS.If) {
      const r = boolCondition(chain, view, s.condition.id);
      if (r !== undefined) out.add(r.witness);
      collectConstCondWitnesses(s.body, chain, view, out);
      if (s.elseBlock) collectConstCondWitnesses(s.elseBlock, chain, view, out);
    } else if (s instanceof StmtNS.While || s instanceof StmtNS.For) {
      collectConstCondWitnesses(s.body, chain, view, out);
    } else if (s instanceof StmtNS.FileInput) {
      collectConstCondWitnesses(s.statements, chain, view, out);
    }
  }
}

class DeadBranchVisitor extends BaseStmtVisitor {
  changed = false;
  constructor(
    private readonly chain: AssumptionChain,
    private readonly view: FunctionLocator,
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
    const r = boolCondition(this.chain, this.view, stmt.condition.id);
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
  bind(wl) {
    wl.onTransformFactDirty(deadBranchRule, typeAnalysis.facts, (_, b) => [b.unit]);
  },
  sweep(unit: Function, chain: AssumptionChain, view: FunctionLocator): boolean {
    const witnesses = new Set<AssumptionChain>();
    collectConstCondWitnesses(visibleBody(unit, chain), chain, view, witnesses);
    return runWitnessSweep(
      unit,
      witnesses,
      (witness) => new DeadBranchVisitor(witness, view),
    );
  },
};
