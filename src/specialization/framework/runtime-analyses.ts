// Runtime observation analyses. Written via `Worklist.observe`; tier "runtime".

import { StmtNS } from "../../ast-types";
import { ROOT_CONTEXT } from "./context";
import type { FactStore } from "./fact-store";
import type { Lattice, Analysis, AnalysisCtx } from "./analysis";
import { classifyRawValue, type RawKind } from "./raw-value";
import type { Worklist } from "./worklist";

// Saturation ceiling; post-saturation writes compare equal and suppress cascade.
export const RUNTIME_CALL_COUNT_SAT = 11;

const RAW_TOP: RawKind = { kind: "unknown" };

// Observation lattice: singletons < ⊤ ({kind:"unknown"}, conflict-absorbing).
// `bottom` is set to RAW_TOP because readers only call `tryRead` on this analysis
// (never `read`), so the declared `bottom` never surfaces as a lattice ⊥.
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
  eq: (a, b) => a === b || rawKindEquals(a, b),
};

/** Runtime observation of per-node value writes. Key = NodeId, value = RawKind.
 *
 *  Declares `onObserve` so the worklist routes each observe call through
 *  the observation→context translator without naming this analysis by
 *  identity. Only ROOT-context observations feed speculation — a non-ROOT
 *  observe would be a test fixture exercising the fact store directly. */
export const runtimeWriteAnalysis: Analysis<number, RawKind> = {
  id: Symbol("runtimeWriteAnalysis"),
  debugName: "runtimeWriteAnalysis",
  lattice: rawValueLattice,
  edges: [
    {
      on: "retire",
      effect: (factStore, _ctx, unit) => {
        for (const nodeId of unit.blockOfNode.keys()) {
          factStore.evict(runtimeWriteAnalysis, nodeId);
        }
      },
    },
  ],
  tier: "runtime",
  onObserve(host, key, value, context) {
    if (context !== ROOT_CONTEXT) return;
    host.handleObservationForSpec(key, value);
  },
  transfer(_factStore: FactStore, _ctx: AnalysisCtx, _key: number): RawKind | undefined {
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
    observe: (p: Analysis<number, RawKind>, k: number, v: RawKind) => void;
    factStore: FactStore;
  },
  nodeId: number,
  raw: unknown,
): void {
  const prev = observer.factStore.tryRead(runtimeWriteAnalysis, nodeId);
  if (prev !== undefined && prev.kind === "unknown") return;
  observer.observe(runtimeWriteAnalysis, nodeId, classifyRawValue(raw));
}

/** Force the per-node observation to ⊤ (`unknown`), erasing any singleton
 *  narrowing the speculative analysis had derived for THIS specific node. */
export function widenWriteObservation(
  observer: { observe: (p: Analysis<number, RawKind>, k: number, v: RawKind) => void },
  nodeId: number,
): void {
  observer.observe(runtimeWriteAnalysis, nodeId, RAW_TOP);
}

/** Saturating call-count lattice: `bottom=0`, join clamped at
 *  `RUNTIME_CALL_COUNT_SAT`. `leq` clamps both sides so it agrees with the
 *  join-induced order — `leq(12, 11)` = `min(11,12) <= min(11,11)` = true.
 *  Without the clamp, writes above SAT would report `leq(value, prev) = false`
 *  and escape the fast path; `FactStore.write` relies on a well-formed
 *  lattice (`leq(v, prev) ⇒ join(prev, v) = prev`) to short-circuit, so the
 *  lattice itself must saturate in both `leq` and `join`. Used by
 *  `runtimeCallAnalysis` for raw observations; consumers read the saturated
 *  value directly. */
export const saturatingCountLattice: Lattice<number> = {
  bottom: 0,
  leq: (a, b) =>
    Math.min(RUNTIME_CALL_COUNT_SAT, a) <= Math.min(RUNTIME_CALL_COUNT_SAT, b),
  join: (a, b) => Math.min(RUNTIME_CALL_COUNT_SAT, Math.max(a, b)),
  eq: (a, b) =>
    Math.min(RUNTIME_CALL_COUNT_SAT, a) === Math.min(RUNTIME_CALL_COUNT_SAT, b),
};

/** Runtime observation of function-entry counts. Key = FunctionDef.id. */
export const runtimeCallAnalysis: Analysis<number, number> = {
  id: Symbol("runtimeCallAnalysis"),
  debugName: "runtimeCallAnalysis",
  lattice: saturatingCountLattice,
  edges: [
    {
      on: "retire",
      effect: (factStore, _ctx, unit) => {
        const fd = unit.funcAst;
        if (fd instanceof StmtNS.FunctionDef) {
          factStore.evict(runtimeCallAnalysis, fd.id);
        }
      },
    },
  ],
  tier: "runtime",
  transfer(_factStore: FactStore, _ctx: AnalysisCtx, _key: number): number | undefined {
    return undefined;
  },
};

/** Builds the pair of runtime-observation callbacks used by every JIT evaluator.
 *  The fact-store itself is the call counter: each call reads the current
 *  cell, increments, writes back. Saturation at `RUNTIME_CALL_COUNT_SAT` is
 *  enforced by the lattice's join; the early-return skips the write once
 *  saturated to avoid the worklist roundtrip. The scope-call boundary drains
 *  buffered writes so memoization / tier-up transforms fire before the next
 *  invocation uses the unspecialized body.
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
  return {
    observeNodeWrite: (nodeId, value) => {
      beforeObserve?.();
      observeRuntimeWrite(worklist, nodeId, value);
    },
    observeScopeCall: (scopeId) => {
      beforeObserve?.();
      const cur = worklist.factStore.tryRead(runtimeCallAnalysis, scopeId) ?? 0;
      if (cur >= RUNTIME_CALL_COUNT_SAT) return;
      worklist.observe(runtimeCallAnalysis, scopeId, cur + 1);
      if (worklist.hasPendingWork()) worklist.drain();
    },
  };
}
