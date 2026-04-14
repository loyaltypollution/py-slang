// Runtime observation passes. Written via `Worklist.observe`; tier "runtime".

import type { FactStore } from "./fact-store";
import type { Lattice, Pass, PassCtx } from "./pass";
import { classifyRawValue, type RawKind } from "./raw-value";

// Saturation ceiling; post-saturation writes compare equal and suppress cascade.
export const RUNTIME_CALL_COUNT_SAT = 11;

const RAW_TOP: RawKind = { kind: "unknown" };

function rawEquals(a: RawKind, b: RawKind): boolean {
  if (a === b) return true;
  if (a.kind !== b.kind) return false;
  switch (a.kind) {
    case "number":
    case "bool":
    case "string":
      return a.value === (b as typeof a).value;
    default:
      return true;
  }
}

function rawJoin(a: RawKind, b: RawKind): RawKind {
  if (a.kind === "unknown" || b.kind === "unknown") return RAW_TOP;
  return rawEquals(a, b) ? a : RAW_TOP;
}

// Monotone observation lattice: ⊥ (never stored; tryRead returns undefined)
// < singletons (one observed RawKind) < ⊤ ({kind:"unknown"}, conflict-absorbing).
// `bottom` is the ⊤ sentinel because no reader calls `factStore.read` on this
// pass (only `tryRead`), so `bottom`'s value is never observed as a lattice ⊥.
const rawValueLattice: Lattice<RawKind> = {
  bottom: RAW_TOP,
  equals: rawEquals,
  join: rawJoin,
};

/** Runtime observation of per-node value writes. Key = NodeId, value = RawKind. */
export const runtimeWritePass: Pass<number, RawKind> = {
  id: Symbol("runtimeWritePass"),
  debugName: "runtimeWritePass",
  lattice: rawValueLattice,
  reads: [],
  tier: "runtime",
  coarse: true,
  transfer(_ctx: PassCtx, _key: number): RawKind | undefined {
    return undefined;
  },
};

/** Runtime-observation sink. Classifies the raw JS value and forwards it to
 *  the worklist. Monotone join (absorbing ⊤ on conflict) is enforced by
 *  `FactStore.write`; this function only adds a fast path for sealed cells:
 *  once a node has seen two distinct values its fact is pinned at ⊤, no raw
 *  value can take it back off, and `classifyRawValue` allocates, so skip it. */
export function observeRuntimeWrite(
  observer: {
    observe: (p: Pass<number, RawKind>, k: number, v: RawKind) => void;
    factStore: FactStore;
  },
  nodeId: number,
  raw: unknown,
): void {
  const prev = observer.factStore.tryRead(runtimeWritePass, nodeId);
  if (prev !== undefined && prev.kind === "unknown") return;
  observer.observe(runtimeWritePass, nodeId, classifyRawValue(raw));
}

const countLattice: Lattice<number> = {
  bottom: 0,
  equals: (a, b) => a === b,
  join: (a, b) => Math.min(RUNTIME_CALL_COUNT_SAT, Math.max(a, b)),
};

/** Runtime observation of function-entry counts. Key = FunctionDef.id. */
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
