import { ExprNS } from "../../ast-types";
import { constAnalysis, type ConstLattice } from "../analysis";
import type { TransformRule } from "../framework/analysis";
import { unitOfBlock, wakeOwningUnit } from "../framework/analysis";
import type { AssumptionChain } from "../assumption/chain";
import { visibleBody } from "../speculation/assumption-bodies";
import type { Unit } from "../framework/function-unit";
import type { UnitView } from "../framework/analysis";
import {
  DescendingExprVisitor,
  ExprDrivenStmtVisitor,
  runWitnessSweep,
  walkExprs,
  type Witnessed,
} from "./witness-utils";

type ConstHit = Witnessed<Extract<ConstLattice, { tag: "const" }>>;

function readConst(chain: AssumptionChain, view: UnitView, nodeId: number): ConstHit | undefined {
  return constAnalysis.perExpr(view).readMinimal(
    chain,
    nodeId,
    (cv: ConstLattice) => cv.tag === "const",
  ) as ConstHit | undefined;
}

class ConstFoldExprVisitor extends DescendingExprVisitor {
  changed = false;

  constructor(
    private readonly chain: AssumptionChain,
    private readonly view: UnitView,
  ) {
    super();
  }

  visitBinaryExpr(expr: ExprNS.Binary): ExprNS.Expr {
    super.visitBinaryExpr(expr);
    const cv = readConst(this.chain, this.view, expr.id);
    if (cv === undefined || cv.witness !== this.chain) return expr;
    this.changed = true;
    return new ExprNS.Literal(expr.startToken, expr.endToken, cv.value.value);
  }
}

export const constantFoldingRule: TransformRule = {
  bind(wl) {
    wl.onTransformFactDirty(
      constantFoldingRule,
      constAnalysis.facts,
      wakeOwningUnit(unitOfBlock),
    );
  },
  sweep(unit: Unit, chain: AssumptionChain, view: UnitView): boolean {
    const witnesses = new Set<AssumptionChain>();
    walkExprs(visibleBody(unit, chain), (e) => {
      if (!(e instanceof ExprNS.Binary)) return;
      const info = readConst(chain, view, e.id);
      if (info !== undefined) witnesses.add(info.witness);
    });
    return runWitnessSweep(
      unit,
      witnesses,
      (witness) => new ExprDrivenStmtVisitor(new ConstFoldExprVisitor(witness, view)),
    );
  },
};
