// src/specialization/optimize.ts — single entry point for the static optimization pipeline

import type { StmtNS } from "../ast-types";
import type { HintTable } from "./framework/hint";
import { annotateTree } from "./framework/hint";
import { stabilizeStatic } from "./framework/dfa-driver";
import type { SlotLookup } from "./types";
import { TypeAnalysisModule } from "./type-analysis/analysis";
import { ConstAnalysisModule } from "./const-analysis/analysis";
import { ConstantFoldingRule } from "./transforms/constant-folding";
import { DeadBranchEliminationRule } from "./transforms/dead-branch";

/**
 * Run the full static optimization pipeline on a statement list:
 * analyze (type + const) → transform (dead branch + constant folding) → re-analyze,
 * repeating until stable. Then annotate the AST with converged hints.
 *
 * Returns the HintTable for consumers that need it before annotation
 * (e.g., tests that inspect hints directly).
 */
export function optimize(stmts: StmtNS.Stmt[], slotLookup: SlotLookup): HintTable {
  const hints: WeakMap<object, any> = new WeakMap();
  stabilizeStatic(
    stmts,
    [new TypeAnalysisModule(), new ConstAnalysisModule()],
    [new DeadBranchEliminationRule(), new ConstantFoldingRule()],
    hints,
    slotLookup,
  );
  annotateTree(stmts, hints);
  return hints;
}
