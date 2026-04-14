// Shared scaffolding for unit-keyed transform rules.
// The `"fired"` top-only lattice guards re-fires; structural rebuild prunes the cell.

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

/** Build a unit-keyed sweep rule. `structuralPass` is auto-appended to `reads`. */
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
    // Evict "fired" on structural rebuild so the rule can fire again.
    prune(_ctx, unit, previousKeys) {
      for (const k of previousKeys) if (k === unit) return [unit];
      return [];
    },
    transfer(ctx: PassCtx, key: FunctionUnit): Fired {
      if (!sweep(key, ctx.factStore)) return undefined;
      return "fired";
    },
  };
}
