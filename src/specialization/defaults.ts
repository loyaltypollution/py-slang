// Production composition of the specialization engine. The framework
// (src/specialization/framework/*) is policy-free; this module names the
// concrete analyses, counters, channels, and transforms that wire it into
// a working pipeline.

import type { StmtNS } from "../ast-types";
import type { FunctionEnvironments } from "../resolver";
import { definitelyBoundAnalysis } from "./definitely-bound-analysis/analysis";
import type { Analysis, Narrowing, TransformRule } from "./framework/analysis";
import type { CounterStore } from "./assumption/counter-store";
import {
  constAnalysis,
  DEFAULT_NARROWINGS,
  typeAnalysis,
  typeRequirementAnalysis,
} from "./framework/narrowing-registry";
import type { FunctionId, NodeId, ParamKey } from "./framework/key-spaces";
import type { ObservationChannel } from "./assumption/observation-channel";
import {
  runtimeCallCounter,
  runtimeParamChannel,
  runtimeReturnChannel,
} from "./assumption/runtime-analyses";
import { Worklist } from "./framework/worklist";
import { livenessAnalysis } from "./liveness-analysis/analysis";
import { purityBlockAnalysis, purityScopeAnalysis } from "./purity-analysis/analysis";
import { algebraicSimplifyRule } from "./transforms/algebraic-simplify";
import { constantFoldingRule } from "./transforms/constant-folding";
import { deadBranchRule } from "./transforms/dead-branch";
import { deadStoreRule } from "./transforms/dead-store";
import { memoizationRule } from "./transforms/memoization";

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

export const DEFAULT_COUNTERS: ReadonlyArray<CounterStore<any>> = [
  runtimeCallCounter,
];

/** Observation channels registered with the default worklist. Under POC
 *  admissibility only param-gated channels are registered — every runtime
 *  observation must bottom out in a function-entry param-type guard. */
export const DEFAULT_CHANNELS: ReadonlyArray<ObservationChannel<any, any>> = [
  runtimeParamChannel,
  runtimeReturnChannel,
];

export const DEFAULT_TRANSFORMS: ReadonlyArray<TransformRule> = [
  deadBranchRule,
  constantFoldingRule,
  algebraicSimplifyRule,
  deadStoreRule,
  memoizationRule,
];

export { DEFAULT_NARROWINGS };
export type { Narrowing, FunctionId, NodeId, ParamKey };

/** Construct a Worklist wired with the default production passes,
 *  transforms, counters, channels, and narrowings. */
export function createDefaultWorklist(
  ast: StmtNS.FileInput,
  functionEnvironments: FunctionEnvironments,
): Worklist {
  return new Worklist(
    ast,
    functionEnvironments,
    DEFAULT_PASSES,
    undefined,
    DEFAULT_TRANSFORMS,
    DEFAULT_NARROWINGS,
    DEFAULT_COUNTERS,
    DEFAULT_CHANNELS,
    [purityBlockAnalysis],
  );
}
