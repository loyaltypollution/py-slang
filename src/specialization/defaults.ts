import type { StmtNS } from "../ast-types";
import type { FunctionEnvironments } from "../resolver";
import {
  constAnalysis,
  definitelyBoundAnalysis,
  livenessAnalysis,
  purityBlockAnalysis,
  purityScopeAnalysis,
  returnKindBinding,
  returnKindNarrowing,
  typeAnalysis,
  typeRequirementAnalysis,
} from "./analysis";
import type { Analysis } from "./framework/analysis";
import { Worklist } from "./framework/worklist";
import { paramTypeBinding, paramTypeNarrowing } from "./narrowing-policy/param-handles";
import type { ObservationBinding } from "./observation/observation-binding";
import {
  runtimeCallCounter,
  runtimeParamChannel,
  runtimeReturnChannel,
} from "./observation/runtime-analyses";
import {
  algebraicSimplifyRule,
  constantFoldingRule,
  deadBranchRule,
  deadStoreRule,
  memoizationRule,
} from "./transforms";

export const DEFAULT_PASSES: ReadonlyArray<Analysis<any, any>> = [
  typeAnalysis.env, typeAnalysis.facts,
  constAnalysis.env, constAnalysis.facts,
  typeRequirementAnalysis.env, typeRequirementAnalysis.facts,
  purityBlockAnalysis.env, purityBlockAnalysis.facts,
  purityScopeAnalysis,
  livenessAnalysis.env, livenessAnalysis.facts,
  definitelyBoundAnalysis.env, definitelyBoundAnalysis.facts,
];

export function createDefaultWorklist(
  ast: StmtNS.FileInput,
  functionEnvironments: FunctionEnvironments,
): Worklist {
  return new Worklist({
    ast,
    functionEnvironments,
    analyses: DEFAULT_PASSES,
    transforms: [deadBranchRule, constantFoldingRule, algebraicSimplifyRule, deadStoreRule, memoizationRule],
    narrowings: [paramTypeNarrowing, returnKindNarrowing],
    counters: [runtimeCallCounter],
    channels: [runtimeParamChannel, runtimeReturnChannel],
    extraEntryBlockAnalyses: [purityBlockAnalysis],
    observationBindings: [paramTypeBinding, returnKindBinding] as ReadonlyArray<ObservationBinding<any, any>>,
  });
}
