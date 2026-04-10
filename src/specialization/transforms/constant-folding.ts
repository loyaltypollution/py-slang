import { ExprNS } from "../../ast-types";
import type { ExprTransformRule } from "../framework/interfaces";
import type { HintTable } from "../framework/hint";
import type { ConstLattice } from "../const-analysis/lattice";

/**
 * Constant folding: replaces a Binary or Compare expression whose result is
 * statically known (constVal.tag === "const") with a Literal node.
 *
 * Reads: hints.get(expr).constVal
 * Fires on: Binary, Compare (after ConstAnalysisModule has converged)
 */
export class ConstantFoldingRule implements ExprTransformRule {
  readonly name = "constant-folding";
  readonly level = "expr" as const;

  matches(expr: ExprNS.Expr, hints: HintTable): boolean {
    if (!(expr instanceof ExprNS.Binary || expr instanceof ExprNS.Compare)) return false;
    return hints.get(expr)?.constVal?.tag === "const";
  }

  apply(expr: ExprNS.Expr, hints: HintTable): ExprNS.Expr {
    const cv = hints.get(expr)!.constVal as ConstLattice & { tag: "const" };
    // Reuse the original expression's token span so source locations remain valid.
    return new ExprNS.Literal(
      expr.startToken,
      expr.endToken,
      cv.value as true | false | number | string,
    );
  }
}
