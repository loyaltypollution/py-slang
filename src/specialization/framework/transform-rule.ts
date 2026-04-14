// Helper for unit-keyed transform rules. The worklist sweeps each rule's
// dirty set after analyses converge; rules that rewrote return `true` to
// schedule a CFG rebuild. Idempotency across rebuilds is the caller's
// concern: dead-branch and const-folding are naturally idempotent (the
// rewrite removes the precondition); memoization tracks a WeakSet of
// already-wrapped units.

import type { FactStore } from "./fact-store";
import type { FunctionUnit } from "./function-unit";
import type { FactEdge, PassCtx, TransformRule } from "./pass";

/** Build a unit-keyed transform rule from a sweep function that reads
 *  fact-store state and mutates `unit.body`. Returns `true` iff the AST
 *  was rewritten. `edges` declares upstream passes whose writes should
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
    sweep(unit: FunctionUnit, factStore: FactStore, _ctx: PassCtx): boolean {
      return sweep(unit, factStore);
    },
  };
}
