// src/specialization/framework/runtime-passes.ts
//
// Runtime observation source passes. The interpreter writes into these
// via `Worklist.observe(pass, key, value)` on every tracked event:
//   - `runtimeWritePass`: per-node RHS observation (assign, etc.)
//   - `runtimeCallPass`:  per-scope call count
//
// `tier: "runtime"` — never drain-dispatched; their values are supplied
// externally. The tier exists so the drain scheduler sorts readers
// (callCountPass, analyses) behind them.

import type { Lattice, Pass, PassCtx } from "./pass";

// ── runtimeWritePass: NodeId → ObservedValue (raw JS value) ─────────────

// Reference equality: the interpreter re-emits raw values, downstream
// analyses do their own widening. Right-biased join: latest wins.
const rawValueLattice: Lattice<unknown> = {
  bottom: undefined,
  equals: (a, b) => a === b,
  join: (_a, b) => b,
};

/**
 * Runtime observation source for per-node value writes (assign RHS, etc.).
 * Key is `NodeId` (number); value is the raw JS value. `transfer` is a
 * no-op — the interpreter writes via `Worklist.observe`.
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
 * Runtime observation source for function-entry counts. Key is the
 * callee `FunctionDef.id`; value is a monotonically-increasing call
 * count. `transfer` is a no-op — the interpreter writes via
 * `Worklist.observe`.
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
