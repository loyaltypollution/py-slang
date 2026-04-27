import { ROOT_CONTEXT, type AssumptionChain } from "../assumption";
import { defineAnalysis, type Analysis, type JoinSemiLattice } from "../framework/analysis";
import { paramKey, type ParamKey } from "../narrowing-policy/param-key";
import type { FunctionId } from "../program/function/function";
import { ObservationSource } from "./observation-channel";
import { classifyRawValue, RAW_UNKNOWN, type RawKind } from "./raw-value";

export interface JitObservationRuntime<U> {
  readonly locate: {
    functionById(id: FunctionId): U | undefined;
  };
  futureDispatchChainFor(unit: U): AssumptionChain;
  observe<K, V>(
    source: ObservationSource<K, V>,
    key: K,
    observed: V,
    context: AssumptionChain,
  ): AssumptionChain;
  /** External-write ingress: combine `value` into `analysis[key]@context` via
   *  the analysis's join, fan out to subscribers, and drive analyses to
   *  fixpoint. Used for chain-relative facts (e.g. call hotness) that are
   *  produced by the runtime, not computed from read facts. */
  publish<K, V>(
    analysis: Analysis<K, V>,
    key: K,
    value: V,
    context: AssumptionChain,
  ): void;
}

export interface JitObservers {
  observeScopeCall(scopeId: FunctionId): void;
  observeScopeReturn(scopeId: FunctionId, value: unknown): void;
  observeParamEntry(scopeId: FunctionId, paramIndex: number, value: unknown): void;
  currentChainFor(scopeId: FunctionId): AssumptionChain;
}

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

function rawKindLeq(a: RawKind, b: RawKind): boolean {
  return b.kind === "unknown" || rawKindEquals(a, b);
}

function joinRawKinds(a: RawKind, b: RawKind): RawKind {
  if (a.kind === "unknown" || b.kind === "unknown") {
    return RAW_UNKNOWN;
  }

  if (rawKindEquals(a, b)) {
    return a;
  }

  return RAW_UNKNOWN;
}

function rawKindEq(a: RawKind, b: RawKind): boolean {
  return a === b || rawKindEquals(a, b);
}

export const rawValueJoinSemiLattice: JoinSemiLattice<RawKind> = {
  bottom: RAW_UNKNOWN,
  leq: rawKindLeq,
  join: joinRawKinds,
  eq: rawKindEq,
};

function rawObservationIsUnknown(value: RawKind): boolean {
  return value.kind === "unknown";
}

export const runtimeParamSource: ObservationSource<ParamKey, RawKind> = new ObservationSource(
  rawObservationIsUnknown,
);

export const runtimeReturnSource: ObservationSource<FunctionId, RawKind> = new ObservationSource(
  rawObservationIsUnknown,
);

/** Saturation cap for `callHotnessAnalysis`. Memoization fires one call before
 *  the cap (see `memoizationRule.sweep`) so the wrapper is installed before
 *  the call that would otherwise refute on the next observation. */
export const CALL_HOTNESS_TOP = 11;

/** Chain-relative call-hotness as a saturation level. Lattice is the chain
 *  `0 ⊑ 1 ⊑ … ⊑ CALL_HOTNESS_TOP` with `join = max`. The cell is written
 *  exclusively by the JIT runtime via `Worklist.publish`; transfer is
 *  unreachable (the cell is never enqueued).
 *
 *  Storage is keyed by `(FunctionId, chain)`. Each dispatch chain accumulates
 *  its own count — a freshly specialized variant must earn its own
 *  saturation, independent of the parent body's hotness. */
const callHotnessSemilattice: JoinSemiLattice<number> = {
  bottom: 0,
  leq: (a, b) => a <= b,
  join: (a, b) => (a > b ? a : b),
  eq: (a, b) => a === b,
};

export const callHotnessAnalysis: Analysis<FunctionId, number> = defineAnalysis({
  storeAlgebra: callHotnessSemilattice,
  tier: "runtime",
  polarity: "may",
  transfer: () => undefined,
});

export function makeJitObservers<U>(runtime: JitObservationRuntime<U>): JitObservers {
  const scopeIds: FunctionId[] = [];
  const chains: AssumptionChain[] = [];

  function requireTop(scopeId: FunctionId, operation: string): number {
    const top = scopeIds.length - 1;
    if (top < 0 || scopeIds[top] !== scopeId) {
      const actual = top < 0 ? "empty" : scopeIds[top];
      throw new Error(`[makeJitObservers] ${operation}(${scopeId}) but stack top is ${actual}`);
    }
    return top;
  }

  function observeScopeCall(scopeId: FunctionId): void {
    const unit = runtime.locate.functionById(scopeId);
    // Resolve the dispatch chain BEFORE publishing so the increment lands
    // chain-relative — calls under different specialization contexts must
    // accumulate independently.
    const provenanceChain =
      unit !== undefined ? runtime.futureDispatchChainFor(unit) : ROOT_CONTEXT;
    if (unit !== undefined) {
      const cur = callHotnessAnalysis.store.tryRead(scopeId, provenanceChain) ?? 0;
      if (cur < CALL_HOTNESS_TOP) {
        runtime.publish(callHotnessAnalysis, scopeId, cur + 1, provenanceChain);
      }
    }

    scopeIds.push(scopeId);
    chains.push(provenanceChain);
  }

  function observeScopeReturn(scopeId: FunctionId, value: unknown): void {
    const top = requireTop(scopeId, "observeScopeReturn");
    try {
      runtime.observe(runtimeReturnSource, scopeId, classifyRawValue(value), chains[top]);
    } finally {
      scopeIds.pop();
      chains.pop();
    }
  }

  function observeParamEntry(scopeId: FunctionId, paramIndex: number, value: unknown): void {
    const top = requireTop(scopeId, "observeParamEntry");
    const key = paramKey(scopeId, paramIndex);
    chains[top] = runtime.observe(runtimeParamSource, key, classifyRawValue(value), chains[top]);
  }

  function currentChainFor(scopeId: FunctionId): AssumptionChain {
    const top = scopeIds.length - 1;
    return top >= 0 && scopeIds[top] === scopeId ? chains[top] : ROOT_CONTEXT;
  }

  return {
    observeScopeCall,
    observeScopeReturn,
    observeParamEntry,
    currentChainFor,
  };
}
