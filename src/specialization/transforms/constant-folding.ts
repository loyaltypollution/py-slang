import { ExprNS, StmtNS } from "../../ast-types";
import { constAnalysis, type ConstLattice } from "../analysis";
import type { TransformRule } from "../framework/analysis";
import type { AssumptionChain } from "../assumption/chain";
import { visibleBody } from "../speculation/assumption-bodies";
import type { Function } from "../program/function/function";
import type { FunctionLocator } from "../program/function/manager";
import { DescendingExprVisitor, IdReplacer, rewriteStmtRhs } from "./expr-visitor";
import { groupPlansByWitness, runPerWitness } from "./witness-sweep";

type Plan = { witness: AssumptionChain; replacement: ExprNS.Expr };

class ConstFoldMatcher extends DescendingExprVisitor {
  constructor(
    private readonly chain: AssumptionChain,
    private readonly view: FunctionLocator,
    private readonly out: Map<number, Plan>,
  ) {
    super();
  }

  visitBinaryExpr(expr: ExprNS.Binary): ExprNS.Expr {
    super.visitBinaryExpr(expr);
    const cv = constAnalysis
      .perExpr(this.view)
      .readMinimal(this.chain, expr.id, (v: ConstLattice) => v.tag === "const");
    if (cv === undefined || cv.value.tag !== "const") return expr;
    this.out.set(expr.id, {
      witness: cv.witness,
      replacement: new ExprNS.Literal(expr.startToken, expr.endToken, cv.value.value),
    });
    return expr;
  }
}

export const constantFoldingRule: TransformRule = {
  bind(wl) {
    wl.onTransformFactDirty(constantFoldingRule, constAnalysis.facts, (_, b) => [b.unit]);
  },
  sweep(unit: Function, chain: AssumptionChain, view: FunctionLocator) {
    const plans = new Map<number, Plan>();
    rewriteStmtRhs(visibleBody(unit, chain) as StmtNS.Stmt[], new ConstFoldMatcher(chain, view, plans));

    return runPerWitness(unit, groupPlansByWitness(plans), (body, replacements) => {
      const replacer = new IdReplacer(replacements);
      rewriteStmtRhs(body, replacer);
      return replacer.changed;
    });
  },
};
