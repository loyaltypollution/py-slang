// Runtime observation surfaces. Not `Analysis`es — no transfer, no
// polarity, no chain-based fact semantics. Observations enter via
// `Worklist.publish(channel, ...)` which dedup-writes through the
// channel's shadow AND feeds the observation→context translator.

import { ROOT_CONTEXT, type AssumptionChain } from "../assumption";
import { paramKey, type FunctionId, type JoinSemiLattice, type ParamKey } from "../framework/analysis";
import type { Worklist } from "../framework/worklist";
import { CounterStore } from "./counter-store";
import { ObservationChannel } from "./observation-channel";
import { classifyRawValue, RAW_UNKNOWN, type RawKind } from "./raw-value";

// Saturation ceiling; post-saturation writes compare equal and suppress cascade.
export const RUNTIME_CALL_COUNT_SAT = 11;

// Observation lattice: singletons < ⊤ (RAW_UNKNOWN, conflict-absorbing).
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
  bottom: RAW_UNKNOWN,
  leq: (a, b) => b.kind === "unknown" || rawKindEquals(a, b),
  join: (a, b) =>
    a.kind === "unknown" || b.kind === "unknown"
      ? RAW_UNKNOWN
      : rawKindEquals(a, b) ? a : RAW_UNKNOWN,
  eq: (a, b) => a === b || rawKindEquals(a, b),
};

/** Per-parameter entry-value observations. Feeds paramKey-scoped narrowings. */
export const runtimeParamChannel: ObservationChannel<ParamKey, RawKind> =
  new ObservationChannel<ParamKey, RawKind>(rawValueLattice);

/** Per-function return-kind observations. Feeds the return-kind narrowing. */
export const runtimeReturnChannel: ObservationChannel<FunctionId, RawKind> =
  new ObservationChannel<FunctionId, RawKind>(rawValueLattice);

/** Runtime call-count counter, keyed by FunctionDef.id. */
export const runtimeCallCounter: CounterStore<FunctionId> =
  new CounterStore<FunctionId>(RUNTIME_CALL_COUNT_SAT);

/** Builds the runtime-observation callbacks used by every JIT evaluator.
 *
 *  Chain provenance: a LIFO call-stack shadow (`scopeIds[]` + `chains[]`).
 *  `observeScopeCall` pushes the unit's current future-dispatch chain;
 *  `observeScopeReturn` pops. Observations attribute to the top-of-stack
 *  chain, or ROOT at top level. `observeParamEntry` may refine the
 *  current chain in place. */
export function makeJitObservers(
  worklist: Worklist
): {
  observeScopeCall: (scopeId: FunctionId) => void;
  observeScopeReturn: (scopeId: FunctionId, value: unknown) => void;
  observeParamEntry: (scopeId: FunctionId, paramIndex: number, value: unknown) => void;
  currentChainFor: (scopeId: FunctionId) => AssumptionChain;
} {
  // Parallel arrays instead of {scopeId, chain} wrappers — per-call
  // allocation would churn young-gen on the hot path.
  const scopeIds: FunctionId[] = [];
  const chains: AssumptionChain[] = [];

  function requireTop(scopeId: FunctionId, op: string): number {
    const top = scopeIds.length - 1;
    if (top < 0 || scopeIds[top] !== scopeId) {
      const actual = top < 0 ? "empty" : scopeIds[top];
      throw new Error(`[makeJitObservers] ${op}(${scopeId}) but stack top is ${actual} — call/return pairing violated`);
    }
    return top;
  }

  return {
    observeScopeCall: (scopeId) => {
      const unit = worklist.units.get(scopeId);
      const provenanceChain = unit !== undefined ? worklist.futureDispatchChainFor(unit) : ROOT_CONTEXT;
      scopeIds.push(scopeId);
      chains.push(provenanceChain);
      worklist.bump(runtimeCallCounter, scopeId);
    },
    observeScopeReturn: (scopeId, value) => {
      // Pop AFTER observing so the return attributes to the unwinding call.
      const top = requireTop(scopeId, "observeScopeReturn");
      worklist.publish(runtimeReturnChannel, scopeId, classifyRawValue(value), chains[top]);
      scopeIds.pop();
      chains.pop();
    },
    observeParamEntry: (scopeId, paramIndex, value) => {
      const top = requireTop(scopeId, "observeParamEntry");
      const key = paramKey(scopeId, paramIndex);
      chains[top] = worklist.publish(runtimeParamChannel, key, classifyRawValue(value), chains[top]);
    },
    currentChainFor: (scopeId) => {
      const top = scopeIds.length - 1;
      return top >= 0 && scopeIds[top] === scopeId ? chains[top] : ROOT_CONTEXT;
    },
  };
}
