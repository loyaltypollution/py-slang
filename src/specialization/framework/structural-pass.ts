// src/specialization/framework/structural-pass.ts
//
// Singleton `Pass<FunctionUnit, AstVersion>` written through by
// `Worklist.processTransform` (on transform fire) and re-primed by
// `Worklist.rebuildStructural`. Value is a monotonically-increasing integer;
// every transform round produces a strictly-greater value, so `lattice.equals`
// is plain numeric equality and suppresses fan-out when a rebuild is elided.
//
// `transfer` is a no-op: this pass is a *source*, not a derived fact. It
// exists so analyses / transforms / the JIT can declare
// `reads: [structuralPass]` and participate in the single dispatch graph
// alongside passes that are derived from runtime observations.
//
// Granularity is the `FunctionUnit` itself (one AST-version per unit). This
// is plan item (c)'s natural granularity for the `prune` hook — on a write
// to `structuralPass[unit]`, every pass whose keyspace is derived from that
// unit's CFG has the opportunity to evict stale BlockId-shaped keys.

import type { Lattice, Pass, PassCtx } from "./pass";
import type { FunctionUnit } from "./function-unit";

export type AstVersion = number;

const astVersionLattice: Lattice<AstVersion> = {
  bottom: 0,
  equals: (a, b) => a === b,
  join: (a, b) => Math.max(a, b),
};

/**
 * The framework-level "something about this unit's CFG changed" signal.
 * Written through by `Worklist.rebuildStructural`; read by any pass whose
 * fixpoint depends on AST shape (type/const analyses, transforms, JIT).
 */
export const structuralPass: Pass<FunctionUnit, AstVersion> = {
  id: Symbol("structuralPass"),
  debugName: "structuralPass",
  lattice: astVersionLattice,
  reads: [],
  tier: "runtime",
  coarse: true,
  transfer(_ctx: PassCtx, _unit: FunctionUnit): AstVersion | undefined {
    // Externally written by rebuildStructural; no derivation.
    return undefined;
  },
};
