// Constant folding of Binary expressions to Literals. Idempotent (the Literal
// no longer matches). Witness-aware: each fold publishes at the shallowest
// chain that proves the expression constant.

import { ExprNS, StmtNS } from "../../ast-types";
import type { ConstLattice } from "../const-analysis/lattice";
import type { TransformRule } from "../framework/analysis";
import { unitOfBlock, wakeOwningUnit } from "../framework/analysis";
import type { AssumptionChain } from "../lattice/chain";
import { visibleBody } from "../assumption/assumption-bodies";
import { constAnalysis } from "../framework/narrowing-registry";
import type { Unit } from "../framework/function-unit";
import type { ProgramTopology } from "../framework/topology";
import {
  DescendingExprVisitor,
  ExprDrivenStmtVisitor,
  runWitnessSweep,
  walkExprs,
} from "./witness-utils";

type ConstWitness = { value: Extract<ConstLattice, { tag: "const" }>; witness: AssumptionChain };

function constInfo(
  chain: AssumptionChain,
  topology: ProgramTopology,
  nodeId: number,
): ConstWitness | undefined {
  return constAnalysis
    .perExpr(topology)
    .readMinimal(chain, nodeId, (cv: ConstLattice) => cv.tag === "const") as
    | ConstWitness
    | undefined;
}

function collectWitnesses(
  chain: AssumptionChain,
  topology: ProgramTopology,
  stmts: readonly StmtNS.Stmt[],
  out: Set<AssumptionChain>,
): void {
  walkExprs(stmts, (e) => {
    if (!(e instanceof ExprNS.Binary)) return;
    const info = constInfo(chain, topology, e.id);
    if (info !== undefined) out.add(info.witness);
  });
}

class ConstFoldExprVisitor extends DescendingExprVisitor {
  changed = false;

  constructor(
    private readonly chain: AssumptionChain,
    private readonly topology: ProgramTopology,
  ) {
    super();
  }

  visitBinaryExpr(expr: ExprNS.Binary): ExprNS.Expr {
    expr.left = expr.left.accept(this);
    expr.right = expr.right.accept(this);
    const cv = constInfo(this.chain, this.topology, expr.id);
    if (cv === undefined || cv.witness !== this.chain) return expr;
    this.changed = true;
    return new ExprNS.Literal(expr.startToken, expr.endToken, cv.value.value);
  }
}

export const constantFoldingRule: TransformRule = {
  sweep(unit: Unit, chain: AssumptionChain, topology: ProgramTopology): boolean {
    const witnesses = new Set<AssumptionChain>();
    collectWitnesses(chain, topology, visibleBody(unit, chain), witnesses);
    return runWitnessSweep(
      unit,
      witnesses,
      (witness) => new ExprDrivenStmtVisitor(new ConstFoldExprVisitor(witness, topology)),
    );
  },
  bind(wl) {
    wl.onTransformFactDirty(
      constantFoldingRule,
      constAnalysis.facts,
      wakeOwningUnit(unitOfBlock),
    );
  },
};
