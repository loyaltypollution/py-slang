import { StmtNS } from "../../ast-types";
import type { Lattice } from "./lattice";
import { defineInput, InputHandle } from "./input";

const observedValueLattice: Lattice<unknown> = {
  bottom: undefined,
  equals: (a, b) => a === b,
  join: (_a, b) => b,
};

// Saturating count, max 50 per architecture-most-correct.md §callCountOf.
// equals must compare post-saturation so writes past 50 are no-ops at the
// cell layer (writeInput gates on equals, not join). Without this, the
// downstream early-cutoff guarantee (Phase 2 spec test 3) fails.
const SATURATION = 50;
const callCountLattice: Lattice<number> = {
  bottom: 0,
  equals: (a, b) => Math.min(a, SATURATION) === Math.min(b, SATURATION),
  join: (a, b) => Math.min(Math.max(a, b), SATURATION),
};

const astLattice: Lattice<StmtNS.FileInput | undefined> = {
  bottom: undefined,
  equals: (a, b) => a === b,
  join: (_a, b) => b,
};

// Multi-unit support is future work; unit key 0 is the sole parsed unit
// per evaluator invocation today.
export const astOf: InputHandle<number, StmtNS.FileInput | undefined> =
  defineInput("astOf", astLattice, String);

export const runtimeWrite: InputHandle<number, unknown> =
  defineInput("runtimeWrite", observedValueLattice, String);

export const runtimeCall: InputHandle<number, number> =
  defineInput("runtimeCall", callCountLattice, String);
