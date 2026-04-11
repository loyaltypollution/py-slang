import { StmtNS } from "../../ast-types";
import type { StmtTransformRule } from "../framework/interfaces";
import type { HintStore } from "../framework/hint";
import type { ConstLattice } from "../const-analysis/lattice";

/**
 * Dead branch elimination: replaces an If statement whose condition is a
 * statically known boolean constant with the taken branch body.
 *
 * Reads: hints.get(if.condition).constVal
 * Fires on: If where condition is const(true) or const(false)
 */
export class DeadBranchEliminationRule implements StmtTransformRule {
  readonly name = "dead-branch-elimination";
  readonly level = "stmt" as const;

  matches(stmt: StmtNS.Stmt, hints: HintStore): boolean {
    if (!(stmt instanceof StmtNS.If)) return false;
    const cv = hints.get(stmt.condition)?.constVal;
    return cv?.tag === "const" && typeof cv.value === "boolean";
  }

  apply(stmt: StmtNS.Stmt, hints: HintStore): StmtNS.Stmt[] {
    const ifStmt = stmt as StmtNS.If;
    const cv = hints.get(ifStmt.condition)!.constVal as ConstLattice & { tag: "const" };
    return cv.value ? ifStmt.body : (ifStmt.elseBlock ?? []);
  }
}
