import type { Pass } from "./pass";
import type { OptimizationHint, HintField, FieldEquals } from "./hint";

/**
 * Per-HintField `Pass<number, V | undefined>`. These passes exist purely so
 * the fact store can back hint storage: they declare no `reads` and their
 * `transfer` is a no-op (hints are externally written by analysis/transform
 * code paths via `HintStore.setById` / `updateField`, not derived inside
 * the framework).
 *
 * `lattice.bottom` is `undefined` — the "field absent" state. `lattice.equals`
 * delegates to the per-field `FieldEquals` supplied by the owning `HintStore`,
 * which in practice is wired from each `AnalysisPass.latticeEquals` in the
 * worklist. Primitive scope-summary fields (`pure`, `callCount`) fall back
 * to `===`.
 *
 * Passes are per-`HintStore` (created via `createHintPasses`) because the
 * `FieldEquals` registry is dynamically supplied at worklist construction
 * time and must not leak across worklist instances. Pass identity is the
 * fact-store key, so allocating fresh symbols per store also naturally
 * partitions the fact store cells per unit.
 */
export type HintPasses = {
  readonly [K in HintField]: Pass<number, OptimizationHint[K]>;
};

const DEFAULT_EQ: FieldEquals = (a, b) => a === b;

const HINT_FIELDS: readonly HintField[] = ["type", "constVal", "callCount", "pure"];

export function createHintPasses(
  fieldEq: ReadonlyMap<string, FieldEquals> = new Map(),
): HintPasses {
  const out = {} as { [K in HintField]: Pass<number, OptimizationHint[K]> };
  for (const field of HINT_FIELDS) {
    const eq = fieldEq.get(field) ?? DEFAULT_EQ;
    const pass: Pass<number, OptimizationHint[typeof field]> = {
      id: Symbol(`hint:${field}`),
      debugName: `hint:${field}`,
      lattice: {
        bottom: undefined,
        equals(a, b) {
          if (a === undefined && b === undefined) return true;
          if (a === undefined || b === undefined) return false;
          return eq(a, b);
        },
        join(_a, b) {
          return b;
        },
      },
      reads: [],
      transfer() {
        return undefined;
      },
    };
    (out as Record<HintField, Pass<number, unknown>>)[field] = pass as Pass<number, unknown>;
  }
  return out;
}
