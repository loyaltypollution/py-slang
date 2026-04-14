// Helper for unit-keyed transform rules. The worklist sweeps each rule's
// dirty set after analyses converge; rules that rewrote return `true` to
// schedule a CFG rebuild. Idempotency across rebuilds is the caller's
// concern: dead-branch and const-folding are naturally idempotent (the
// rewrite removes the precondition); memoization tracks a WeakSet of
// already-wrapped units.

import type { FactStore } from "./fact-store";
import type { FunctionUnit } from "./function-unit";
import type { PassCtx, TransformRule } from "./pass";

/** Build a unit-keyed transform rule from a sweep function that reads
 *  fact-store state and mutates `unit.body`. Returns `true` iff the AST
 *  was rewritten. */
export function unitSweepRule(
  name: string,
  sweep: (unit: FunctionUnit, factStore: FactStore) => boolean,
): TransformRule {
  return {
    id: Symbol(name),
    debugName: name,
    sweep(unit: FunctionUnit, ctx: PassCtx): boolean {
      return sweep(unit, ctx.factStore);
    },
  };
}
