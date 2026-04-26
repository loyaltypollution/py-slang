import { ROOT_CONTEXT, type AssumptionChain } from "../assumption";
import type { JoinSemiLattice } from "../framework/analysis";
import { paramKey, type ParamKey } from "../narrowing-policy/param-key";
import type { FunctionId } from "../program/function/function";
import { SaturatingCounter } from "./counter-store";
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
  incrementPolicyCounter<K>(counter: SaturatingCounter<K>, key: K): void;
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

export const runtimeCallHotness: SaturatingCounter<FunctionId> = new SaturatingCounter(11);

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
    const provenanceChain =
      unit !== undefined ? runtime.futureDispatchChainFor(unit) : ROOT_CONTEXT;

    runtime.incrementPolicyCounter(runtimeCallHotness, scopeId);
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
