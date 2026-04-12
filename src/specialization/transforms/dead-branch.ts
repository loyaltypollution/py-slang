import { StmtNS } from "../../ast-types";
import type { StmtTransformRule } from "../framework/interfaces";
import { CONST_ANALYSIS_KEY, type HintStore } from "../framework/hint";
import type { ConstLattice } from "../const-analysis/lattice";

/**
 * Dead branch elimination: replaces an If statement whose condition is a
 * statically known boolean constant with the taken branch body. Queries
 * const-analysis via its typed key.
 */
export class DeadBranchEliminationRule implements StmtTransformRule {
  readonly name = "dead-branch-elimination";
  readonly level = "stmt" as const;

  matches(stmt: StmtNS.Stmt, hints: HintStore): boolean {
    if (!(stmt instanceof StmtNS.If)) return false;
    const cv = hints.getTyped(stmt.condition, CONST_ANALYSIS_KEY);
    return cv?.tag === "const" && typeof cv.value === "boolean";
  }

  apply(stmt: StmtNS.Stmt, hints: HintStore): StmtNS.Stmt[] {
    const ifStmt = stmt as StmtNS.If;
    const cv = hints.getTyped(ifStmt.condition, CONST_ANALYSIS_KEY) as ConstLattice & { tag: "const" };
    return cv.value ? ifStmt.body : (ifStmt.elseBlock ?? []);
  }
}
