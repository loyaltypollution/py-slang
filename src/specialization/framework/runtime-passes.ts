// src/specialization/framework/runtime-passes.ts
//
// Stub runtime source passes. PR-4 introduces these as placeholders so
// analyses can declare `reads: [runtimeWritePass, structuralPass]` /
// `reads: [runtimeCallPass]` today. PR-5 wires the interpreter to write
// into them via `Worklist.observe(pass, key, value)`; until then these
// passes carry no facts and their `transfer` is never invoked.
//
// `tier: "runtime"` — they are never `drain`-dispatched; they are source
// passes whose values are supplied externally. The fields exist so the
// drain policy sorts passes that read them behind `"analysis"` tier.

import type { Lattice, Pass, PassCtx } from "./pass";

// ── runtimeWritePass: NodeId → ObservedValue (raw JS value) ─────────────

const rawValueLattice: Lattice<unknown> = {
  bottom: undefined,
  // Raw-observation values are widened by downstream analyses; at the
  // framework layer we only need to know whether a new observation is
  // distinguishable from the last one. Reference equality suffices — the
  // interpreter re-emits the raw value on each write.
  equals: (a, b) => a === b,
  // Right-biased join: the latest observation wins at this layer.
  // Analyses supply their own lattice join via their own pass.
  join: (_a, b) => b,
};

/**
 * Runtime observation source for per-node value writes (assign RHS, etc.).
 * Stub in PR-4: key is `NodeId` (number), value is the raw JS value.
 * `transfer` is a no-op — externally written by the interpreter in PR-5.
 */
export const runtimeWritePass: Pass<number, unknown> = {
  id: Symbol("runtimeWritePass"),
  debugName: "runtimeWritePass",
  lattice: rawValueLattice,
  reads: [],
  tier: "runtime",
  coarse: true,
  transfer(_ctx: PassCtx, _key: number): unknown {
    return undefined;
  },
};

// ── runtimeCallPass: Scope → call count ────────────────────────────────

const countLattice: Lattice<number> = {
  bottom: 0,
  equals: (a, b) => a === b,
  join: (a, b) => Math.max(a, b),
};

/**
 * Runtime observation source for function-entry counts. Stub in PR-4:
 * key is the callee scope AST node. `transfer` is a no-op — externally
 * written by the interpreter in PR-5.
 */
export const runtimeCallPass: Pass<number, number> = {
  id: Symbol("runtimeCallPass"),
  debugName: "runtimeCallPass",
  lattice: countLattice,
  reads: [],
  tier: "runtime",
  coarse: true,
  transfer(_ctx: PassCtx, _key: number): number | undefined {
    return undefined;
  },
};
