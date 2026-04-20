// Runtime observation analyses. Written via `Worklist.observe`; tier "runtime".

import { StmtNS } from "../../ast-types";
import { ROOT_CONTEXT } from "./context";
import {
  defineAnalysis,
  type JoinSemiLattice,
  type Analysis,
  type AnalysisCtx,
  type OpaqueAnalysis,
} from "./analysis";
import { storeEvict } from "./analysis-store";
import {
  paramKey,
  type FunctionId,
  type NodeId,
  type ParamKey,
} from "./key-spaces";
import { classifyRawValue, type RawKind } from "./raw-value";
import type { Worklist } from "./worklist";

// Saturation ceiling; post-saturation writes compare equal and suppress cascade.
export const RUNTIME_CALL_COUNT_SAT = 11;

const RAW_TOP: RawKind = { kind: "unknown" };

// Observation lattice over the stored runtime-observation domain.
// Singletons < ⊤ ({kind:"unknown"}, conflict-absorbing).
//
// Important store/semantic distinction: `bottom` is set to RAW_TOP because
// readers only call `tryRead` on this analysis (never `read`), so the
// declared `bottom` is mainly satisfying the AnalysisStore surface rather than
// exposing a meaningful semantic least fact to consumers.
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

const rawValueLattice: JoinSemiLattice<RawKind> = {
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
 *  identity. Only ROOT-context observations feed speculation; `Worklist.observe`
 *  hardcodes ROOT, and the guard here documents that rule at the analysis
 *  boundary. */
export const runtimeWriteAnalysis: OpaqueAnalysis<NodeId, RawKind> = defineAnalysis({
  id: Symbol("runtimeWriteAnalysis"),
  debugName: "runtimeWriteAnalysis",
  keySpace: "nodeId",
  storeAlgebra: rawValueLattice,
  edges: [
    {
      on: "retire",
      effect: (ctx, unit) => {
        for (const nodeId of ctx.topology.nodesOfUnit(unit)) {
          storeEvict(runtimeWriteAnalysis.store, nodeId, ROOT_CONTEXT);
        }
      },
    },
  ],
  tier: "runtime",
  polarity: "opaque",
  onObserve(host, key, value, context) {
    if (context !== ROOT_CONTEXT) return;
    host.handleObservationForSpec(runtimeWriteAnalysis, key, value);
  },
  transfer(_ctx: AnalysisCtx, _key: NodeId): RawKind | undefined {
    return undefined;
  },
});

/** Fast path the monotone store can't see: once a cell has saturated to ⊤
 *  (`unknown`), no future observation can change either the stored fact or
 *  the speculation policy outcome. Equal non-⊤ repeats are STILL forwarded
 *  to `Worklist.observe`: `onObserve` must see every event even when the
 *  store write would be a no-op (e.g. count-based strategies). Returns the
 *  lifted `RawKind` to publish, or `undefined` only for the sealed-⊤ case. */
function nextObservationOrSkip(prev: RawKind | undefined, raw: unknown): RawKind | undefined {
  if (prev !== undefined && prev.kind === "unknown") return undefined;
  return classifyRawValue(raw);
}

export function observeRuntimeWrite(
  observer: {
    observe: (p: Analysis<NodeId, RawKind>, k: NodeId, v: RawKind) => void;
  },
  nodeId: NodeId,
  raw: unknown,
): void {
  const prev = runtimeWriteAnalysis.store.tryRead(nodeId, ROOT_CONTEXT);
  const lifted = nextObservationOrSkip(prev, raw);
  if (lifted === undefined) return;
  observer.observe(runtimeWriteAnalysis, nodeId, lifted);
}

/** Force the per-node observation to ⊤ (`unknown`), erasing any singleton
 *  narrowing the speculative analysis had derived for THIS specific node. */
export function widenWriteObservation(
  observer: { observe: (p: Analysis<NodeId, RawKind>, k: NodeId, v: RawKind) => void },
  nodeId: NodeId,
): void {
  observer.observe(runtimeWriteAnalysis, nodeId, RAW_TOP);
}

/** Runtime observation of per-function return kinds. Key = FunctionDef.id
 *  (functionId). Feeds the return-kind narrowing dimension: a stable observation
 *  at functionId extends the called unit's speculation context with a
 *  per-function return-type assumption, which the must-backward type-
 *  requirement analysis seeds at the unit's Return statements.
 *
 *  Keyed by functionId rather than the Return statement's node id because the
 *  narrowing's value domain is a summary across *all* return paths — a
 *  function with two Returns carries one assumption, not two. `onObserve`
 *  forwards to `handleObservationForSpec` with `runtimeReturnAnalysis` as
 *  the source, so the observation→context translator routes only to
 *  narrowings declaring this same source. Only ROOT-context observations
 *  feed speculation, matching `Worklist.observe`'s hardcoded ROOT entry. */
export const runtimeParamAnalysis: OpaqueAnalysis<ParamKey, RawKind> = defineAnalysis({
  id: Symbol("runtimeParamAnalysis"),
  debugName: "runtimeParamAnalysis",
  keySpace: "paramKey",
  storeAlgebra: rawValueLattice,
  edges: [
    {
      on: "retire",
      effect: (_ctx, unit) => {
        const fd = unit.funcAst;
        if (!(fd instanceof StmtNS.FunctionDef)) return;
        for (let i = 0; i < fd.parameters.length; i++) {
          storeEvict(runtimeParamAnalysis.store, paramKey(fd.id, i), ROOT_CONTEXT);
        }
      },
    },
  ],
  tier: "runtime",
  polarity: "opaque",
  onObserve(host, key, value, context) {
    if (context !== ROOT_CONTEXT) return;
    host.handleObservationForSpec(runtimeParamAnalysis, key, value);
  },
  transfer(_ctx: AnalysisCtx, _key: ParamKey): RawKind | undefined {
    return undefined;
  },
});

/** Emit a function-entry parameter observation. Called once per argument at
 *  callee entry by JIT-capable evaluators. */
export function observeRuntimeParam(
  observer: { observe: (p: Analysis<ParamKey, RawKind>, k: ParamKey, v: RawKind) => void },
  functionId: FunctionId,
  paramIndex: number,
  raw: unknown,
): void {
  const key = paramKey(functionId, paramIndex);
  const prev = runtimeParamAnalysis.store.tryRead(key, ROOT_CONTEXT);
  const lifted = nextObservationOrSkip(prev, raw);
  if (lifted === undefined) return;
  observer.observe(runtimeParamAnalysis, key, lifted);
}

export const runtimeReturnAnalysis: OpaqueAnalysis<FunctionId, RawKind> = defineAnalysis({
  id: Symbol("runtimeReturnAnalysis"),
  debugName: "runtimeReturnAnalysis",
  keySpace: "functionId",
  storeAlgebra: rawValueLattice,
  edges: [
    {
      on: "retire",
      effect: (_ctx, unit) => {
        const fd = unit.funcAst;
        if (fd instanceof StmtNS.FunctionDef) {
          storeEvict(runtimeReturnAnalysis.store, fd.id, ROOT_CONTEXT);
        }
      },
    },
  ],
  tier: "runtime",
  polarity: "opaque",
  onObserve(host, key, value, context) {
    if (context !== ROOT_CONTEXT) return;
    host.handleObservationForSpec(runtimeReturnAnalysis, key, value);
  },
  transfer(_ctx: AnalysisCtx, _key: FunctionId): RawKind | undefined {
    return undefined;
  },
});

/** Emit a return-kind observation for `functionId`. Mirrors `observeRuntimeWrite`:
 *  classifies the raw JS value, short-circuits when the cell has already
 *  saturated to ⊤, otherwise forwards to the worklist. Backends call this
 *  once per completed function return. */
export function observeRuntimeReturn(
  observer: {
    observe: (p: Analysis<FunctionId, RawKind>, k: FunctionId, v: RawKind) => void;
  },
  functionId: FunctionId,
  raw: unknown,
): void {
  const prev = runtimeReturnAnalysis.store.tryRead(functionId, ROOT_CONTEXT);
  const lifted = nextObservationOrSkip(prev, raw);
  if (lifted === undefined) return;
  observer.observe(runtimeReturnAnalysis, functionId, lifted);
}

/** Saturating call-count lattice: `bottom=0`, join clamped at
 *  `RUNTIME_CALL_COUNT_SAT`. `leq` clamps both sides so it agrees with the
 *  join-induced order — `leq(12, 11)` = `min(11,12) <= min(11,11)` = true.
 *  Without the clamp, writes above SAT would report `leq(value, prev) = false`
 *  and escape the fast path; `AnalysisStore.write` relies on a
 *  well-formed lattice (`leq(v, prev) ⇒ join(prev, v) = prev`) to
 *  short-circuit, so the lattice itself must saturate in both `leq` and
 *  `join`. Used by `runtimeCallAnalysis` for raw observations; consumers
 *  read the saturated value directly. */
export const saturatingCountLattice: JoinSemiLattice<number> = {
  bottom: 0,
  leq: (a, b) =>
    Math.min(RUNTIME_CALL_COUNT_SAT, a) <= Math.min(RUNTIME_CALL_COUNT_SAT, b),
  join: (a, b) => Math.min(RUNTIME_CALL_COUNT_SAT, Math.max(a, b)),
  eq: (a, b) =>
    Math.min(RUNTIME_CALL_COUNT_SAT, a) === Math.min(RUNTIME_CALL_COUNT_SAT, b),
};

/** Runtime observation of function-entry counts. Key = FunctionDef.id. */
export const runtimeCallAnalysis: OpaqueAnalysis<FunctionId, number> = defineAnalysis({
  id: Symbol("runtimeCallAnalysis"),
  debugName: "runtimeCallAnalysis",
  keySpace: "functionId",
  storeAlgebra: saturatingCountLattice,
  edges: [
    {
      on: "retire",
      effect: (_ctx, unit) => {
        const fd = unit.funcAst;
        if (fd instanceof StmtNS.FunctionDef) {
          storeEvict(runtimeCallAnalysis.store, fd.id, ROOT_CONTEXT);
        }
      },
    },
  ],
  tier: "runtime",
  polarity: "opaque",
  transfer(_ctx: AnalysisCtx, _key: FunctionId): number | undefined {
    return undefined;
  },
});

/** Builds the runtime-observation callbacks used by every JIT evaluator.
 *  The `runtimeCallAnalysis` store itself is the call counter: each call reads
 *  the current cell, increments, writes back. Saturation at
 *  `RUNTIME_CALL_COUNT_SAT` is
 *  enforced by the store algebra's join; the early-return skips the write once
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
  observeNodeWrite: (nodeId: NodeId, value: unknown) => void;
  observeScopeCall: (scopeId: FunctionId) => void;
  observeScopeReturn: (scopeId: FunctionId, value: unknown) => void;
  observeParamEntry: (scopeId: FunctionId, paramIndex: number, value: unknown) => void;
} {
  return {
    observeNodeWrite: (nodeId, value) => {
      beforeObserve?.();
      observeRuntimeWrite(worklist, nodeId, value);
    },
    // Convergence is the caller's responsibility. Observations enter the
    // worklist immediately; evaluators choose when to run the full
    // transform/rebuild drain loop.
    observeScopeCall: (scopeId) => {
      beforeObserve?.();
      const cur = runtimeCallAnalysis.store.tryRead(scopeId, ROOT_CONTEXT) ?? 0;
      if (cur >= RUNTIME_CALL_COUNT_SAT) return;
      worklist.observe(runtimeCallAnalysis, scopeId, cur + 1);
    },
    observeScopeReturn: (scopeId, value) => {
      beforeObserve?.();
      observeRuntimeReturn(worklist, scopeId, value);
    },
    observeParamEntry: (scopeId, paramIndex, value) => {
      beforeObserve?.();
      observeRuntimeParam(worklist, scopeId, paramIndex, value);
    },
  };
}
