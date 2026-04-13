// Shared scaffolding for unit-keyed transform rules (dead-branch,
// constant-folding). The top-only `"fired"` lattice is the
// re-fire guard: once set, a re-write yields `equals === true`,
// suppressing `onChange` and downstream wakes. On structural rebuild the
// cell must be pruned so the rule can fire again on the new body.

import type { FactStore } from "./fact-store";
import type { FunctionUnit } from "./function-unit";
import type { Lattice, Pass, PassCtx } from "./pass";
import { structuralPass } from "./structural-pass";

export type Fired = "fired" | undefined;

export const firedLattice: Lattice<Fired> = {
  bottom: undefined,
  equals: (a, b) => a === b,
  join: (a, b) => (a ?? b),
};

/**
 * Build a unit-keyed sweep rule. `reads` must include any per-node fact
 * passes the sweep consults; `structuralPass` is appended automatically
 * and drives both `affectedKeys` and `prune`.
 */
export function unitSweepRule(
  name: string,
  reads: ReadonlyArray<Pass<any, any>>,
  sweep: (unit: FunctionUnit, factStore: FactStore) => boolean,
): Pass<FunctionUnit, Fired> {
  return {
    id: Symbol(name),
    debugName: name,
    lattice: firedLattice,
    reads: [...reads, structuralPass],
    tier: "transform",
    affectedKeys(_ctx, triggerPass, triggerKey) {
      if (triggerPass === (structuralPass as Pass<any, any>)) {
        return [triggerKey as FunctionUnit];
      }
      return [];
    },
    // Evict the "fired" cell for this unit on structural rebuild so the
    // rule can re-fire against the new body. Without this the top-only
    // lattice permanently suppresses re-entry.
    prune(_ctx, unit, previousKeys) {
      // Fact-store keysets are unique, so at most one match exists.
      for (const k of previousKeys) if (k === unit) return [unit];
      return [];
    },
    transfer(ctx: PassCtx, key: FunctionUnit): Fired {
      if (!sweep(key, ctx.factStore)) return undefined;
      return "fired";
    },
  };
}
