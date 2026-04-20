// Runtime observation analyses. Written via `Worklist.observe`; tier "runtime".

import { StmtNS } from "../../ast-types";
import { ROOT_CONTEXT, type AssumptionChain } from "./context";
import type { Unit } from "./function-unit";
import {
  defineAnalysis,
  type JoinSemiLattice,
  type Analysis,
  type AnalysisCtx,
  type OpaqueAnalysis,
} from "./analysis";
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
  edges: [],
  tier: "runtime",
  polarity: "opaque",
  onObserve(host, key, value, context) {
    if (context !== ROOT_CONTEXT) return;
    host.handleObservationForSpec(runtimeWriteAnalysis, key, value);
  },
  transfer(_ctx: AnalysisCtx, _key: NodeId): RawKind | undefined {
    return undefined;
  },
  bind(wl) {
    // Pre-migration shape: retire edge with `effect` that loops
    // `nodesOfUnit(unit)` and `storeEvict(..., ROOT_CONTEXT)`. Hard-coded
    // ROOT preserved verbatim via `h.evictAt(..., ROOT_CONTEXT)` —
    // §2.4/§3.2 of the plan keeps ROOT-context observations as the only
    // surface this analysis writes to, so `evictAcrossContexts` would be
    // a behavioral change (would evict non-ROOT partitions a future
    // backend may legitimately write). Migration is mechanical only.
    wl.onRetireEvict((h, unit) => {
      for (const nodeId of wl.topology.nodesOfUnit(unit)) {
        h.evictAt(runtimeWriteAnalysis.store, nodeId, ROOT_CONTEXT);
      }
    });
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
    observe: (p: Analysis<NodeId, RawKind>, k: NodeId, v: RawKind, ctx: AssumptionChain) => void;
  },
  nodeId: NodeId,
  raw: unknown,
  context: AssumptionChain,
): void {
  const prev = context.tryRead(runtimeWriteAnalysis, nodeId);
  const lifted = nextObservationOrSkip(prev, raw);
  if (lifted === undefined) return;
  observer.observe(runtimeWriteAnalysis, nodeId, lifted, context);
}

/** Force the per-node observation to ⊤ (`unknown`), erasing any singleton
 *  narrowing the speculative analysis had derived for THIS specific node. */
export function widenWriteObservation(
  observer: {
    observe: (p: Analysis<NodeId, RawKind>, k: NodeId, v: RawKind, ctx: AssumptionChain) => void;
  },
  nodeId: NodeId,
  context: AssumptionChain,
): void {
  observer.observe(runtimeWriteAnalysis, nodeId, RAW_TOP, context);
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
  edges: [],
  tier: "runtime",
  polarity: "opaque",
  onObserve(host, key, value, context) {
    if (context !== ROOT_CONTEXT) return;
    host.handleObservationForSpec(runtimeParamAnalysis, key, value);
  },
  transfer(_ctx: AnalysisCtx, _key: ParamKey): RawKind | undefined {
    return undefined;
  },
  bind(wl) {
    wl.onRetireEvict((h, unit) => {
      const fd = unit.funcAst;
      if (!(fd instanceof StmtNS.FunctionDef)) return;
      for (let i = 0; i < fd.parameters.length; i++) {
        h.evictAt(runtimeParamAnalysis.store, paramKey(fd.id, i), ROOT_CONTEXT);
      }
    });
  },
});

/** Emit a function-entry parameter observation. Called once per argument at
 *  callee entry by JIT-capable evaluators. */
export function observeRuntimeParam(
  observer: {
    observe: (p: Analysis<ParamKey, RawKind>, k: ParamKey, v: RawKind, ctx: AssumptionChain) => void;
  },
  functionId: FunctionId,
  paramIndex: number,
  raw: unknown,
  context: AssumptionChain,
): void {
  const key = paramKey(functionId, paramIndex);
  const prev = context.tryRead(runtimeParamAnalysis, key);
  const lifted = nextObservationOrSkip(prev, raw);
  if (lifted === undefined) return;
  observer.observe(runtimeParamAnalysis, key, lifted, context);
}

export const runtimeReturnAnalysis: OpaqueAnalysis<FunctionId, RawKind> = defineAnalysis({
  id: Symbol("runtimeReturnAnalysis"),
  debugName: "runtimeReturnAnalysis",
  keySpace: "functionId",
  storeAlgebra: rawValueLattice,
  edges: [],
  tier: "runtime",
  polarity: "opaque",
  onObserve(host, key, value, context) {
    if (context !== ROOT_CONTEXT) return;
    host.handleObservationForSpec(runtimeReturnAnalysis, key, value);
  },
  transfer(_ctx: AnalysisCtx, _key: FunctionId): RawKind | undefined {
    return undefined;
  },
  bind(wl) {
    wl.onRetireEvict((h, unit) => {
      const fd = unit.funcAst;
      if (fd instanceof StmtNS.FunctionDef) {
        h.evictAt(runtimeReturnAnalysis.store, fd.id, ROOT_CONTEXT);
      }
    });
  },
});

/** Emit a return-kind observation for `functionId`. Mirrors `observeRuntimeWrite`:
 *  classifies the raw JS value, short-circuits when the cell has already
 *  saturated to ⊤, otherwise forwards to the worklist. Backends call this
 *  once per completed function return. */
export function observeRuntimeReturn(
  observer: {
    observe: (p: Analysis<FunctionId, RawKind>, k: FunctionId, v: RawKind, ctx: AssumptionChain) => void;
  },
  functionId: FunctionId,
  raw: unknown,
  context: AssumptionChain,
): void {
  const prev = context.tryRead(runtimeReturnAnalysis, functionId);
  const lifted = nextObservationOrSkip(prev, raw);
  if (lifted === undefined) return;
  observer.observe(runtimeReturnAnalysis, functionId, lifted, context);
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
  edges: [],
  tier: "runtime",
  polarity: "opaque",
  transfer(_ctx: AnalysisCtx, _key: FunctionId): number | undefined {
    return undefined;
  },
  bind(wl) {
    wl.onRetireEvict((h, unit) => {
      const fd = unit.funcAst;
      if (fd instanceof StmtNS.FunctionDef) {
        h.evictAt(runtimeCallAnalysis.store, fd.id, ROOT_CONTEXT);
      }
    });
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
 *  ## Chain provenance
 *
 *  The adapter maintains an internal call-stack shadow. On `observeScopeCall`
 *  it commits the unit's currently-active speculation chain and pushes a
 *  frame; on `observeScopeReturn` it pops. All in-between observations
 *  (`observeNodeWrite`, `observeParamEntry`, return value itself) attribute
 *  to the stack-top frame's chain. Top-level observations with no enclosing
 *  call use `ROOT_CONTEXT`.
 *
 *  Commit-at-entry eliminates the staleness window between dispatch and
 *  observation: even if `worklist.specAssumptionChainFor(unit)` advances
 *  during the call, the observations made inside this invocation continue
 *  to attribute to the chain the body was selected under.
 *
 *  Body-selection callers (CSE's `specializedFunctionBodyFor`) read the
 *  same committed chain via `committedChainFor(scopeId)` so dispatch and
 *  observations agree on the chain.
 *
 *  ## Engine contract assumed
 *
 *  - `observeScopeCall(scopeId)` fires before any other observation in the
 *    callee, and before `specializedFunctionBodyFor(scopeId)` is queried.
 *  - `observeScopeReturn(scopeId, value)` fires on every unwind. Today the
 *    engines have no exceptions and no tail calls, so plain return is the
 *    only unwind path; if either is added later, the adapter's stack
 *    discipline must be revisited.
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
  /** Committed chain for the currently-executing scopeId, set when its
   *  `observeScopeCall` fired. Returns `ROOT_CONTEXT` when the stack top is
   *  not this scopeId — including when the stack is empty (top-level), or
   *  when the engine queries body selection without a matching call hook. */
  committedChainFor: (scopeId: FunctionId) => AssumptionChain;
} {
  type Frame = { scopeId: FunctionId; unit: Unit | undefined; chain: AssumptionChain };
  const stack: Frame[] = [];
  const currentChain = (): AssumptionChain =>
    stack.length === 0 ? ROOT_CONTEXT : stack[stack.length - 1].chain;

  return {
    observeNodeWrite: (nodeId, value) => {
      beforeObserve?.();
      observeRuntimeWrite(worklist, nodeId, value, currentChain());
    },
    // Convergence is the caller's responsibility. Observations enter the
    // worklist immediately; evaluators choose when to run the full
    // transform/rebuild drain loop.
    observeScopeCall: (scopeId) => {
      beforeObserve?.();
      const unit = worklist.topology.unitOfFunctionId(scopeId);
      const chain = unit !== undefined ? worklist.specAssumptionChainFor(unit) : ROOT_CONTEXT;
      stack.push({ scopeId, unit, chain });
      const cur = chain.tryRead(runtimeCallAnalysis, scopeId) ?? 0;
      if (cur >= RUNTIME_CALL_COUNT_SAT) return;
      worklist.observe(runtimeCallAnalysis, scopeId, cur + 1, chain);
    },
    observeScopeReturn: (scopeId, value) => {
      beforeObserve?.();
      // The return observation belongs to the frame being unwound; pop
      // AFTER observing so the chain attribution is correct.
      const top = stack.length > 0 ? stack[stack.length - 1] : undefined;
      const chain = top !== undefined && top.scopeId === scopeId ? top.chain : ROOT_CONTEXT;
      observeRuntimeReturn(worklist, scopeId, value, chain);
      if (top !== undefined && top.scopeId === scopeId) stack.pop();
    },
    observeParamEntry: (scopeId, paramIndex, value) => {
      beforeObserve?.();
      observeRuntimeParam(worklist, scopeId, paramIndex, value, currentChain());
    },
    committedChainFor: (scopeId) => {
      const top = stack.length > 0 ? stack[stack.length - 1] : undefined;
      return top !== undefined && top.scopeId === scopeId ? top.chain : ROOT_CONTEXT;
    },
  };
}
