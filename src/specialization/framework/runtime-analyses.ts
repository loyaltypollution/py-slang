// Runtime observation surfaces. Not `Analysis`es — these carry no
// transfer, no polarity, no chain-based fact semantics. Observations
// enter the engine via `Worklist.publish(channel, ...)` which dedup-writes
// through the channel's shadow AND feeds the observation→context
// translator (narrowings keyed by `observationSource === channel`).
//
// ## POC admissibility: param-only
//
// Only observations that bottom out in a param-type guard at function
// entry are admissible, because that is the only place the current
// backend can deopt. Two channels survive:
//
//   - `runtimeParamChannel` — direct param-type / param-const entry
//     assumptions.
//   - `runtimeReturnChannel` — per-callee return-kind observations that
//     `returnKindNarrowing` lowers to entry-block type requirements via
//     `requirementAtEntry`, which svml-compiler emits as param-type guards
//     at entry.
//
// Mid-body observation (`runtimeWriteChannel`, `observeNodeWrite`,
// `observeRuntimeWrite`) was removed in full — see commit history. A
// future backend that supports sub-function guarded specialization would
// reintroduce a node-keyed channel alongside a transform that can emit a
// minimal guarded region; there is no salvageable infrastructure from the
// previous incarnation worth preserving as dead code.
//
// Call hotness is a saturating counter, split into `runtimeCallCounter`
// (see `counter-store.ts`) because it's a profitability signal rather
// than semantic evidence.

import { StmtNS } from "../../ast-types";
import type { JoinSemiLattice } from "./analysis";
import { ROOT_CONTEXT, type AssumptionChain } from "./assumption-chain";
import { defineCounterStore, type CounterStore } from "./counter-store";
import {
  paramKey,
  type FunctionId,
  type ParamKey,
} from "./key-spaces";
import {
  defineObservationChannel,
  type ObservationChannel,
} from "./observation-channel";
import { classifyRawValue, type RawKind } from "./raw-value";
import type { Worklist } from "./worklist";

// Saturation ceiling; post-saturation writes compare equal and suppress cascade.
export const RUNTIME_CALL_COUNT_SAT = 11;

const RAW_TOP: RawKind = { kind: "unknown" };

// Observation lattice over the stored runtime-observation domain.
// Singletons < ⊤ ({kind:"unknown"}, conflict-absorbing). `bottom` is set
// to RAW_TOP because readers only call `tryReadAt` on these channels
// (never `read`); the declared `bottom` satisfies the AnalysisStore shadow
// without exposing a semantic least fact.
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

/** Per-parameter entry-value observations. Key = ParamKey, value = RawKind.
 *  Feeds paramKey-scoped narrowings (entry specialization on param types). */
export const runtimeParamChannel: ObservationChannel<ParamKey, RawKind> =
  defineObservationChannel<ParamKey, RawKind>({
    lattice: rawValueLattice,
    bind(wl) {
      wl.onRetireEvict((_h, unit) => {
        const fd = unit.funcAst;
        if (!(fd instanceof StmtNS.FunctionDef)) return;
        for (let i = 0; i < fd.parameters.length; i++) {
          runtimeParamChannel.evictKeyAcrossChains(paramKey(fd.id, i));
        }
      });
    },
  });

/** Per-function return-kind observations. Key = FunctionId (FunctionDef.id),
 *  value = RawKind. Feeds the return-kind narrowing — an observation at
 *  functionId extends the called unit's speculation context with a per-function
 *  return-type assumption. Keyed by functionId rather than Return-statement
 *  nodeId because the narrowing's value domain is a summary across all return
 *  paths — a function with two Returns carries one assumption. */
export const runtimeReturnChannel: ObservationChannel<FunctionId, RawKind> =
  defineObservationChannel<FunctionId, RawKind>({
    lattice: rawValueLattice,
    bind(wl) {
      wl.onRetireEvict((_h, unit) => {
        const fd = unit.funcAst;
        if (fd instanceof StmtNS.FunctionDef) {
          runtimeReturnChannel.evictKeyAcrossChains(fd.id);
        }
      });
    },
  });

/** Runtime call-count counter. Key = FunctionDef.id.
 *
 *  Call hotness is a profitability signal, not semantic speculation evidence,
 *  so this is a `CounterStore` rather than an `Analysis` or channel: no
 *  lattice, no transfer, no chain-keyed reads. Observers read via
 *  `runtimeCallCounter.at(fid)`; bumps land via
 *  `worklist.bump(runtimeCallCounter, fid)`. Saturates at
 *  `RUNTIME_CALL_COUNT_SAT` — post-saturation bumps are no-ops and do not
 *  dispatch, avoiding cascade work once the signal is stable. */
export const runtimeCallCounter: CounterStore<FunctionId> = defineCounterStore<FunctionId>({
  saturation: RUNTIME_CALL_COUNT_SAT,
  bind(wl) {
    wl.onRetireEvict((_h, unit) => {
      const fd = unit.funcAst;
      if (fd instanceof StmtNS.FunctionDef) {
        runtimeCallCounter.evict(fd.id);
      }
    });
  },
});

/** Builds the runtime-observation callbacks used by every JIT evaluator.
 *  Call hotness flows through `runtimeCallCounter`: each `observeScopeCall`
 *  issues one `worklist.bump`. Saturation at `RUNTIME_CALL_COUNT_SAT` is
 *  enforced by the counter itself — post-saturation bumps are no-ops and
 *  skip dispatch. The scope-call boundary drains buffered writes so
 *  memoization / tier-up transforms fire before the next invocation uses
 *  the unspecialized body.
 *
 *  ## Chain provenance
 *
 *  The adapter maintains a LIFO call-stack shadow as two parallel arrays —
 *  `scopeIds[]` and `chains[]` — indexed by depth. `observeScopeCall` pushes
 *  the unit's current future-dispatch chain; `observeScopeReturn` pops. All
 *  in-between observations (`observeParamEntry`, return value itself)
 *  attribute to the top-of-stack chain. Top-level observations with no
 *  enclosing call use `ROOT_CONTEXT`.
 *
 *  Param / return observations may refine or prune the current chain as
 *  execution continues; `observeParamEntry` updates `chains[top]` in place.
 *  Body-selection callers read the current provenance via
 *  `currentChainFor(scopeId)` so parameter-driven entry specialization is
 *  visible before the callee body is chosen.
 *
 *  ## Engine contract assumed
 *
 *  - `observeScopeCall(scopeId)` fires before any other observation in the
 *    callee, and before body-selection for `scopeId` is queried.
 *  - `observeScopeReturn(scopeId, value)` fires on every unwind. Today the
 *    engines have no exceptions and no tail calls, so plain return is the
 *    only unwind path; if either is added later, the adapter's stack
 *    discipline must be revisited.
 */
export function makeJitObservers(
  worklist: Worklist
): {
  observeScopeCall: (scopeId: FunctionId) => void;
  observeScopeReturn: (scopeId: FunctionId, value: unknown) => void;
  observeParamEntry: (scopeId: FunctionId, paramIndex: number, value: unknown) => void;
  /** Top-of-stack provenance chain for the currently-executing `scopeId`.
   *  Returns `ROOT_CONTEXT` when the stack top is not this `scopeId` —
   *  including when the stack is empty (top-level), or when the engine
   *  queries body selection without a matching call hook. */
  currentChainFor: (scopeId: FunctionId) => AssumptionChain;
} {
  // Parallel arrays instead of Frame objects: `observeScopeCall` fires on
  // every function invocation, so allocating a `{scopeId, provenanceChain}`
  // wrapper per call is pure young-gen churn on the hot path. Two arrays
  // with a shared depth index carry the same LIFO state with zero per-push
  // allocation beyond the occasional array-grow amortized doubling.
  const scopeIds: FunctionId[] = [];
  const chains: AssumptionChain[] = [];

  const topIsScope = (scopeId: FunctionId): boolean =>
    scopeIds.length > 0 && scopeIds[scopeIds.length - 1] === scopeId;

  return {
    // Convergence is the caller's responsibility. Observations enter the
    // worklist immediately; evaluators choose when to run the full
    // transform/rebuild drain loop.
    observeScopeCall: (scopeId) => {
      const unit = worklist.topology.unitOfFunctionId(scopeId);
      const provenanceChain = unit !== undefined ? worklist.futureDispatchChainFor(unit) : ROOT_CONTEXT;
      scopeIds.push(scopeId);
      chains.push(provenanceChain);
      worklist.bump(runtimeCallCounter, scopeId);
    },
    observeScopeReturn: (scopeId, value) => {
      // The return observation belongs to the call being unwound; pop
      // AFTER observing so the chain attribution is correct. Contract:
      // stack top must be this scopeId — observeScopeCall always fires
      // first. Mismatch means the engine violated call/return pairing
      // (exceptions, tail calls, missed hook); fail loud rather than
      // silently drifting chain attribution.
      if (!topIsScope(scopeId)) {
        const topId = scopeIds.length > 0 ? scopeIds[scopeIds.length - 1] : "empty";
        throw new Error(
          `[makeJitObservers] observeScopeReturn(${scopeId}) but stack top is ${topId} — call/return pairing violated`,
        );
      }
      const chain = chains[chains.length - 1];
      // Publish may prune/extend the chain, but we pop immediately after
      // so the updated value would be discarded. Just drop the result.
      worklist.publish(runtimeReturnChannel, scopeId, classifyRawValue(value), chain);
      scopeIds.pop();
      chains.pop();
    },
    observeParamEntry: (scopeId, paramIndex, value) => {
      // Contract: stack top must be this scopeId — observeScopeCall fires
      // before any callee observation, including param entry. A mismatch
      // would silently read the caller's chain and overwrite it with the
      // callee's observation result; throw instead of corrupting.
      if (!topIsScope(scopeId)) {
        const topId = scopeIds.length > 0 ? scopeIds[scopeIds.length - 1] : "empty";
        throw new Error(
          `[makeJitObservers] observeParamEntry(${scopeId}, ${paramIndex}) but stack top is ${topId} — callee scope must be pushed first`,
        );
      }
      const top = chains.length - 1;
      const chain = chains[top];
      const key = paramKey(scopeId, paramIndex);
      chains[top] = worklist.publish(runtimeParamChannel, key, classifyRawValue(value), chain);
    },
    currentChainFor: (scopeId) => {
      return topIsScope(scopeId) ? chains[chains.length - 1] : ROOT_CONTEXT;
    },
  };
}
