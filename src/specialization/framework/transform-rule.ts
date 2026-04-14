// Shared scaffolding for unit-keyed transform rules.
// The `"fired"` top-only lattice guards re-fires; structural rebuild evicts the cell.

import type { FactStore } from "./fact-store";
import type { FunctionUnit } from "./function-unit";
import type { Lattice, Pass, PassCtx } from "./pass";
import { structuralPass } from "./structural-pass";

export type Fired = "fired" | undefined;

export const firedLattice: Lattice<Fired> = {
  bottom: undefined,
  leq: (a, b) => a === undefined || a === b,
  join: (a, b) => (a ?? b),
};

/** Build a unit-keyed sweep rule. On `structuralPass` writes for a unit, the
 *  rule wakes on that unit and evicts any stale `"fired"` cell so it can
 *  fire again. Other `reads` are dependency-only — their writes don't wake
 *  the rule. */
export function unitSweepRule(
  name: string,
  reads: ReadonlyArray<Pass<any, any>>,
  sweep: (unit: FunctionUnit, factStore: FactStore) => boolean,
): Pass<FunctionUnit, Fired> {
  return {
    id: Symbol(name),
    debugName: name,
    lattice: firedLattice,
    edges: [
      ...reads.map(p => ({ pass: p })),
      {
        pass: structuralPass,
        wake: (_c, k) => [k as FunctionUnit],
        evict: (_c, k) => [k as FunctionUnit],
      },
    ],
    tier: "transform",
    transfer(ctx: PassCtx, key: FunctionUnit): Fired {
      if (!sweep(key, ctx.factStore)) return undefined;
      return "fired";
    },
  };
}
