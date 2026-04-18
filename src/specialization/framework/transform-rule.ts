// Helper for unit-keyed transform rules. The worklist sweeps each rule's
// dirty set after analyses converge; rules that rewrote return `true` to
// schedule a CFG rebuild. Idempotency across rebuilds is the caller's
// concern — the rewrite must make its own precondition fail (dead-branch
// removes the branch; const-fold replaces the variable; memoization detects
// its own prelude). Rules that cannot become precondition-false on their own
// should not be expressed as sweep-transforms.

import type { FactStore } from "./fact-store";
import type { FunctionUnit } from "./function-unit";
import type { FactEdge, AnalysisCtx, TransformRule } from "./analysis";

/** Build a unit-keyed transform rule from a sweep function that reads
 *  fact-store state and mutates `unit.body`. Returns `true` iff the AST
 *  was rewritten. `edges` declares upstream analyses whose writes should
 *  dirty this rule; omitted, the rule only fires on mint / rebuild. */
export function unitSweepRule(
  name: string,
  sweep: (unit: FunctionUnit, factStore: FactStore) => boolean,
  edges: ReadonlyArray<FactEdge<FunctionUnit>> = [],
): TransformRule {
  return {
    id: Symbol(name),
    debugName: name,
    edges,
    sweep(unit: FunctionUnit, factStore: FactStore, _ctx: AnalysisCtx): boolean {
      return sweep(unit, factStore);
    },
  };
}
