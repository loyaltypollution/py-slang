// Production composition: names the concrete passes, narrowings, channels,
// transforms, and observation bindings wired into the policy-free framework.

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
import type { Analysis, Narrowing } from "./framework/analysis";
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

/** Block DFAs contribute `.env` (Kildall driver) and `.facts` (per-node cell). */
export const DEFAULT_PASSES: ReadonlyArray<Analysis<any, any>> = [
  typeAnalysis.env, typeAnalysis.facts,
  constAnalysis.env, constAnalysis.facts,
  typeRequirementAnalysis.env, typeRequirementAnalysis.facts,
  purityBlockAnalysis.env, purityBlockAnalysis.facts,
  purityScopeAnalysis,
  livenessAnalysis.env, livenessAnalysis.facts,
  definitelyBoundAnalysis.env, definitelyBoundAnalysis.facts,
];

/** Chain dimensions re-seeded at each context entry. Param-only runtime
 *  speculation policy; node-keyed dimensions are fact surfaces, not here. */
export const DEFAULT_NARROWINGS: ReadonlyArray<Narrowing<any, unknown>> = [
  paramTypeNarrowing,
  returnKindNarrowing,
];

/** Runtime ingress paths that drive chain extension; mirrors DEFAULT_NARROWINGS. */
const DEFAULT_OBSERVATION_BINDINGS: ReadonlyArray<ObservationBinding<any, any, any>> = [
  paramTypeBinding,
  returnKindBinding,
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
    narrowings: DEFAULT_NARROWINGS,
    counters: [runtimeCallCounter],
    channels: [runtimeParamChannel, runtimeReturnChannel],
    extraEntryBlockAnalyses: [purityBlockAnalysis],
    observationBindings: DEFAULT_OBSERVATION_BINDINGS,
  });
}
