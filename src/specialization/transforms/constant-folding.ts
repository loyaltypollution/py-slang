import { ExprNS } from "../../ast-types";
import { constAnalysis, type ConstLattice } from "../analysis";
import type { TransformRule } from "../framework/analysis";
import { unitOfBlock, wakeOwningUnit } from "../framework/analysis";
import type { AssumptionChain } from "../assumption/chain";
import { visibleBody } from "../speculation/assumption-bodies";
import type { Unit } from "../framework/function-unit";
import type { ProgramTopology } from "../framework/topology";
import {
  DescendingExprVisitor,
  ExprDrivenStmtVisitor,
  runWitnessSweep,
  walkExprs,
  type Witnessed,
} from "./witness-utils";

type ConstWitness = Witnessed<Extract<ConstLattice, { tag: "const" }>>;

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

class ConstFoldExprVisitor extends DescendingExprVisitor {
  changed = false;

  constructor(
    private readonly chain: AssumptionChain,
    private readonly topology: ProgramTopology,
  ) {
    super();
  }

  visitBinaryExpr(expr: ExprNS.Binary): ExprNS.Expr {
    super.visitBinaryExpr(expr);
    const cv = constInfo(this.chain, this.topology, expr.id);
    if (cv === undefined || cv.witness !== this.chain) return expr;
    this.changed = true;
    return new ExprNS.Literal(expr.startToken, expr.endToken, cv.value.value);
  }
}

export const constantFoldingRule: TransformRule = {
  sweep(unit: Unit, chain: AssumptionChain, topology: ProgramTopology): boolean {
    const witnesses = new Set<AssumptionChain>();
    walkExprs(visibleBody(unit, chain), (e) => {
      if (!(e instanceof ExprNS.Binary)) return;
      const info = constInfo(chain, topology, e.id);
      if (info !== undefined) witnesses.add(info.witness);
    });
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
