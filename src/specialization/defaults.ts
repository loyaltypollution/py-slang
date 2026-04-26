import type { StmtNS } from "../ast-types";
import type { FunctionEnvironments } from "../resolver";
import {
  constAnalysis,
  definitelyBoundAnalysis,
  livenessAnalysis,
  purityBlockAnalysis,
  purityFunctionAnalysis,
  returnKindNarrowing,
  typeAnalysis,
  typeRequirementAnalysis,
} from "./analysis";
import { Worklist } from "./framework/worklist";
import { paramTypeNarrowing } from "./narrowing-policy/param-handles";
import {
  algebraicSimplifyRule,
  constantFoldingRule,
  deadBranchRule,
  deadStoreRule,
  memoizationRule,
} from "./transforms";

const DEFAULT_TRANSFORMS = [
  deadBranchRule,
  constantFoldingRule,
  algebraicSimplifyRule,
  deadStoreRule,
  memoizationRule,
] as const;

export const DEFAULT_PASSES = [
  typeAnalysis.env,
  typeAnalysis.facts,
  constAnalysis.env,
  constAnalysis.facts,
  typeRequirementAnalysis.env,
  typeRequirementAnalysis.facts,
  purityBlockAnalysis.env,
  purityBlockAnalysis.facts,
  purityFunctionAnalysis,
  livenessAnalysis.env,
  livenessAnalysis.facts,
  definitelyBoundAnalysis.env,
  definitelyBoundAnalysis.facts,
];

export function createDefaultWorklist(
  ast: StmtNS.FileInput,
  functionEnvironments: FunctionEnvironments,
): Worklist {
  return new Worklist({
    ast,
    functionEnvironments,
    analyses: DEFAULT_PASSES,
    transforms: DEFAULT_TRANSFORMS,
    narrowings: [paramTypeNarrowing, returnKindNarrowing],
    extraEntrySeeds: [purityBlockAnalysis],
  });
}
