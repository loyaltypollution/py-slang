// Production composition of the specialization engine. The framework
// (src/specialization/framework/*) is policy-free; this module names the
// concrete analyses, counters, channels, transforms, narrowings, and
// observation bindings that wire it into a working pipeline.

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

/** Default production analysis set. Block DFAs contribute `.env` (the
 *  Kildall driver) and `.facts` (the paired per-node cell); both must be
 *  registered. */
export const DEFAULT_PASSES: ReadonlyArray<Analysis<any, any>> = [
  typeAnalysis.env, typeAnalysis.facts,
  constAnalysis.env, constAnalysis.facts,
  typeRequirementAnalysis.env, typeRequirementAnalysis.facts,
  purityBlockAnalysis.env, purityBlockAnalysis.facts,
  purityScopeAnalysis,
  livenessAnalysis.env, livenessAnalysis.facts,
  definitelyBoundAnalysis.env, definitelyBoundAnalysis.facts,
];

/** Default narrowing set — the chain dimensions worklist re-seeds at each
 *  context entry. Policy: param-only runtime speculation. Node-keyed
 *  dimensions exist as fact surfaces but are not registered here. */
export const DEFAULT_NARROWINGS: ReadonlyArray<Narrowing<any, unknown>> = [
  paramTypeNarrowing,
  returnKindNarrowing,
];

/** Default observation bindings — the runtime ingress paths that drive
 *  chain extension. Mirrors `DEFAULT_NARROWINGS`; production wires every
 *  registered narrowing to a binding. */
const DEFAULT_OBSERVATION_BINDINGS: ReadonlyArray<ObservationBinding<any, any>> = [
  paramTypeBinding,
  returnKindBinding,
];

/** Construct a Worklist wired with the default production passes,
 *  transforms, counters, channels, and narrowings. Under POC admissibility
 *  only param-gated channels are registered — every runtime observation
 *  must bottom out in a function-entry param-type guard. */
export function createDefaultWorklist(
  ast: StmtNS.FileInput,
  functionEnvironments: FunctionEnvironments,
): Worklist {
  return new Worklist(
    ast,
    functionEnvironments,
    DEFAULT_PASSES,
    [deadBranchRule, constantFoldingRule, algebraicSimplifyRule, deadStoreRule, memoizationRule],
    DEFAULT_NARROWINGS,
    [runtimeCallCounter],
    [runtimeParamChannel, runtimeReturnChannel],
    [purityBlockAnalysis],
    DEFAULT_OBSERVATION_BINDINGS,
  );
}
