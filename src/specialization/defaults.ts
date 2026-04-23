// Production composition of the specialization engine.
//
// The framework (src/specialization/framework/*) is policy-free: the Worklist
// scheduler, store, and context interner do not import specific analyses or
// transforms. This module names the concrete set that wires them into a
// working pipeline. Tests, alternative backends, or experimental pipelines can
// skip this module and pass their own analyses / transforms / narrowings into
// `new Worklist(...)`.

import type { StmtNS } from "../ast-types";
import type { FunctionEnvironments } from "../resolver";
import { definitelyBoundAnalysis } from "./definitely-bound-analysis/analysis";
import type { Analysis, Narrowing, TransformRule } from "./framework/analysis";
import type { CounterStore } from "./framework/counter-store";
import {
  constAnalysis,
  DEFAULT_NARROWINGS,
  typeAnalysis,
  typeRequirementAnalysis,
} from "./framework/dfa-analyses";
import type { FunctionId, NodeId, ParamKey } from "./framework/key-spaces";
import type { ObservationChannel } from "./framework/observation-channel";
import {
  runtimeCallCounter,
  runtimeParamChannel,
  runtimeReturnChannel,
} from "./framework/runtime-analyses";
import { Worklist } from "./framework/worklist";
import { livenessAnalysis } from "./liveness-analysis/analysis";
import { purityBlockAnalysis, purityScopeAnalysis } from "./purity-analysis/analysis";
import { algebraicSimplifyRule } from "./transforms/algebraic-simplify";
import { constantFoldingRule } from "./transforms/constant-folding";
import { deadBranchRule } from "./transforms/dead-branch";
import { deadStoreRule } from "./transforms/dead-store";
import { memoizationRule } from "./transforms/memoization";

/** Default production analysis set. Tests may use a subset for isolation.
 *  Block DFAs contribute two analyses each — `.env` (the Kildall driver) and
 *  `.facts` (the per-node expr-facts cell populated as a paired side effect).
 *  Both must be registered: `.env` for its transfer + CFG self-wake, `.facts`
 *  for its rebuild/retire eviction subscriptions.
 *
 *  POC admissibility: every runtime observation must bottom out in a
 *  function-entry param-type guard — the only deopt surface the current
 *  backend knows. See `DEFAULT_CHANNELS` / `DEFAULT_COUNTERS`. */
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

/** Observation channels registered with the default worklist. Channels are
 *  not analyses (no transfer, no chain-keyed reads) — they live on their
 *  own registration surface so retire hooks fire and narrowings can route
 *  observations. Under POC admissibility only the two param-gated channels
 *  are registered. */
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

/** Construct a Worklist wired with the default production passes, transforms,
 *  and narrowings. Use when the caller wants the standard specialization
 *  pipeline without restating the composition at every call site. Tests or
 *  backends that need a non-default pipeline call `new Worklist(...)`
 *  directly and pass their own sets. */
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
  );
}

