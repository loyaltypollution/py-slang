import type { Pass } from "./pass";
import type { OptimizationHint, HintField, FieldEquals } from "./hint";
import {
  callCountPass,
  constAnalysisPass,
  purityScopePass,
  typeAnalysisPass,
} from "./migrated-passes";

/**
 * Per-HintField backing `Pass<number, V>`. After PR-4 each field is
 * backed by the corresponding *migrated* `Pass<K, V>` singleton
 * (`typeAnalysisPass`, `constAnalysisPass`, `purityScopePass`,
 * `callCountPass`) rather than a locally-allocated no-op pass. Writes
 * via `HintStore.updateField(id, field, v)` route directly into those
 * passes' fact-store cells, so any consumer that registers with the
 * pass-graph dispatch and declares `reads: [typeAnalysisPass]` (etc.)
 * observes hint writes as regular fact changes.
 *
 * Historical `FieldEquals` override path (used by the legacy worklist
 * to install `AnalysisPass.latticeEquals` per field) is accepted but
 * effectively unused for migrated fields — each migrated pass carries
 * its own `lattice.equals` that matches what `AnalysisPass.latticeEquals`
 * used to supply. The parameter stays on the signature so the worklist
 * construction order (build field-equality map, build units + stores)
 * compiles without churn; PR-6 removes it alongside the demolition of
 * `HintField` / `OptimizationHint`.
 */
export type HintPasses = {
  readonly [K in HintField]: Pass<number, OptimizationHint[K]>;
};

export function createHintPasses(
  _fieldEq: ReadonlyMap<string, FieldEquals> = new Map(),
): HintPasses {
  // After PR-4: all four OptimizationHint fields are produced by migrated
  // passes. `hint-passes.ts` no longer allocates cells of its own — it
  // hands back the migrated passes so `HintStore.{get,set}` read/write
  // through them. `_fieldEq` is intentionally unused; see module doc.
  return {
    type: typeAnalysisPass as unknown as Pass<number, OptimizationHint["type"]>,
    constVal: constAnalysisPass as unknown as Pass<number, OptimizationHint["constVal"]>,
    callCount: callCountPass as unknown as Pass<number, OptimizationHint["callCount"]>,
    pure: purityScopePass as unknown as Pass<number, OptimizationHint["pure"]>,
  };
}
