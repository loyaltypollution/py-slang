// Runtime observation passes. Written via `Worklist.observe`; tier "runtime".

import { StmtNS } from "../../ast-types";
import type { FactStore } from "./fact-store";
import type { Lattice, Pass, PassCtx } from "./pass";
import { classifyRawValue, type RawKind } from "./raw-value";
import type { Worklist } from "./worklist";

// Saturation ceiling; post-saturation writes compare equal and suppress cascade.
export const RUNTIME_CALL_COUNT_SAT = 11;

const RAW_TOP: RawKind = { kind: "unknown" };

// Monotone observation lattice: ⊥ (never stored; tryRead returns undefined)
// < singletons (one observed RawKind) < ⊤ ({kind:"unknown"}, conflict-absorbing).
// `bottom` is the ⊤ sentinel because no reader calls `factStore.read` on this
// pass (only `tryRead`), so `bottom`'s value is never observed as a lattice ⊥.
function rawKindEquals(a: RawKind, b: RawKind): boolean {
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

const rawValueLattice: Lattice<RawKind> = {
  bottom: RAW_TOP,
  leq: (a, b) => b.kind === "unknown" || rawKindEquals(a, b),
  join: (a, b) =>
    a.kind === "unknown" || b.kind === "unknown"
      ? RAW_TOP
      : rawKindEquals(a, b) ? a : RAW_TOP,
};

/** Runtime observation of per-node value writes. Key = NodeId, value = RawKind. */
export const runtimeWritePass: Pass<number, RawKind> = {
  id: Symbol("runtimeWritePass"),
  debugName: "runtimeWritePass",
  lattice: rawValueLattice,
  edges: [
    {
      on: "retire",
      effect: (factStore, _ctx, unit) => {
        for (const nodeId of unit.blockOfNode.keys()) {
          factStore.evict(runtimeWritePass, nodeId);
        }
      },
    },
  ],
  tier: "runtime",
  transfer(_factStore: FactStore, _ctx: PassCtx, _key: number): RawKind | undefined {
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

/** Saturating call-count lattice: `bottom=0`, join clamped at
 *  `RUNTIME_CALL_COUNT_SAT`. `leq` clamps both sides so it agrees with the
 *  join-induced order — `leq(12, 11)` = `min(11,12) <= min(11,11)` = true.
 *  Without the clamp, writes above SAT would report `leq(value, prev) = false`
 *  and escape the fast path; `FactStore.write` relies on a well-formed
 *  lattice (`leq(v, prev) ⇒ join(prev, v) = prev`) to short-circuit, so the
 *  lattice itself must saturate in both `leq` and `join`. Used by
 *  `runtimeCallPass` for raw observations; consumers read the saturated
 *  value directly. */
export const saturatingCountLattice: Lattice<number> = {
  bottom: 0,
  leq: (a, b) =>
    Math.min(RUNTIME_CALL_COUNT_SAT, a) <= Math.min(RUNTIME_CALL_COUNT_SAT, b),
  join: (a, b) => Math.min(RUNTIME_CALL_COUNT_SAT, Math.max(a, b)),
};

/** Runtime observation of function-entry counts. Key = FunctionDef.id. */
export const runtimeCallPass: Pass<number, number> = {
  id: Symbol("runtimeCallPass"),
  debugName: "runtimeCallPass",
  lattice: saturatingCountLattice,
  edges: [
    {
      on: "retire",
      effect: (factStore, _ctx, unit) => {
        const fd = unit.funcAst;
        if (fd instanceof StmtNS.FunctionDef) {
          factStore.evict(runtimeCallPass, fd.id);
        }
      },
    },
  ],
  tier: "runtime",
  transfer(_factStore: FactStore, _ctx: PassCtx, _key: number): number | undefined {
    return undefined;
  },
};

/** Builds the pair of runtime-observation callbacks used by every JIT evaluator.
 *  Per-callee counts live in the returned closure; saturation at
 *  `RUNTIME_CALL_COUNT_SAT` suppresses further cascades, and the scope-call
 *  boundary drains buffered writes so memoization / tier-up transforms fire
 *  before the next invocation uses the unspecialized body.
 *
 *  `beforeObserve` (optional) runs at the head of each callback. The Tiered
 *  evaluator uses it to throw an AbortError when its arm has lost the race;
 *  it must be cheap and may throw to short-circuit the host interpreter. */
export function makeJitObservers(
  worklist: Worklist,
  beforeObserve?: () => void,
): {
  observeNodeWrite: (nodeId: number, value: unknown) => void;
  observeScopeCall: (scopeId: number) => void;
} {
  const callCounts = new Map<number, number>();
  return {
    observeNodeWrite: (nodeId, value) => {
      beforeObserve?.();
      observeRuntimeWrite(worklist, nodeId, value);
    },
    observeScopeCall: (scopeId) => {
      beforeObserve?.();
      const cur = callCounts.get(scopeId) ?? 0;
      if (cur >= RUNTIME_CALL_COUNT_SAT) return;
      const next = cur + 1;
      callCounts.set(scopeId, next);
      worklist.observe(runtimeCallPass, scopeId, next);
      if (worklist.hasPendingWork()) worklist.drain();
    },
  };
}
