import { ExprNS } from "../../ast-types";
import type { ExprTransformRule } from "../framework/interfaces";
import { CONST_ANALYSIS_KEY, type HintStore } from "../framework/hint";
import type { ConstLattice } from "../const-analysis/lattice";

/**
 * Constant folding: replaces a Binary or Compare expression whose result is
 * statically known with a Literal node. Queries const-analysis via its
 * typed key; the transform has no knowledge of the hint record's shape
 * beyond this key.
 */
export class ConstantFoldingRule implements ExprTransformRule {
  readonly name = "constant-folding";
  readonly level = "expr" as const;

  matches(expr: ExprNS.Expr, hints: HintStore): boolean {
    if (!(expr instanceof ExprNS.Binary || expr instanceof ExprNS.Compare)) return false;
    return hints.getTyped(expr, CONST_ANALYSIS_KEY)?.tag === "const";
  }

  apply(expr: ExprNS.Expr, hints: HintStore): ExprNS.Expr {
    const cv = hints.getTyped(expr, CONST_ANALYSIS_KEY) as ConstLattice & { tag: "const" };
    return new ExprNS.Literal(
      expr.startToken,
      expr.endToken,
      cv.value as true | false | number | string,
    );
  }
}
