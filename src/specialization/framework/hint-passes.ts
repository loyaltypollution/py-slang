import type { Pass } from "./pass";
import type { OptimizationHint, HintField, FieldEquals } from "./hint";
import {
  callCountPass,
  constAnalysisPass,
  purityScopePass,
  typeAnalysisPass,
} from "./migrated-passes";

/**
 * Each `HintField` is backed by the corresponding migrated `Pass<K, V>`
 * singleton. Writes via `HintStore.updateField(id, field, v)` route
 * directly into those passes' fact-store cells, so consumers that declare
 * `reads: [typeAnalysisPass]` etc. observe hint writes as regular fact
 * changes. The `FieldEquals` parameter is accepted for call-site
 * compatibility but unused — each migrated pass carries its own
 * `lattice.equals`.
 */
export type HintPasses = {
  readonly [K in HintField]: Pass<number, OptimizationHint[K]>;
};

export function createHintPasses(
  _fieldEq: ReadonlyMap<string, FieldEquals> = new Map(),
): HintPasses {
  return {
    type: typeAnalysisPass as unknown as Pass<number, OptimizationHint["type"]>,
    constVal: constAnalysisPass as unknown as Pass<number, OptimizationHint["constVal"]>,
    callCount: callCountPass as unknown as Pass<number, OptimizationHint["callCount"]>,
    pure: purityScopePass as unknown as Pass<number, OptimizationHint["pure"]>,
  };
}
