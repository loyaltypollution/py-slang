import { ROOT_CONTEXT, type AssumptionChain } from "../assumption";
import { type JoinSemiLattice } from "../framework/analysis";
import type { FunctionId } from "../program/units/function/function";
import { paramKey, type ParamKey } from "../narrowing-policy/param-key";
import type { Worklist } from "../framework/worklist";
import { CounterStore } from "./counter-store";
import { ObservationChannel } from "./observation-channel";
import { classifyRawValue, RAW_UNKNOWN, type RawKind } from "./raw-value";

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

const rawIsUnknown = (v: RawKind): boolean => v.kind === "unknown";

export const runtimeParamChannel: ObservationChannel<ParamKey, RawKind> =
  new ObservationChannel<ParamKey, RawKind>(rawValueLattice, rawIsUnknown);

export const runtimeReturnChannel: ObservationChannel<FunctionId, RawKind> =
  new ObservationChannel<FunctionId, RawKind>(rawValueLattice, rawIsUnknown);

export const runtimeCallCounter: CounterStore<FunctionId> =
  new CounterStore<FunctionId>(11);

export function makeJitObservers(
  worklist: Worklist
): {
  observeScopeCall: (scopeId: FunctionId) => void;
  observeScopeReturn: (scopeId: FunctionId, value: unknown) => void;
  observeParamEntry: (scopeId: FunctionId, paramIndex: number, value: unknown) => void;
  currentChainFor: (scopeId: FunctionId) => AssumptionChain;
} {
  const scopeIds: FunctionId[] = [];
  const chains: AssumptionChain[] = [];

  function requireTop(scopeId: FunctionId, op: string): number {
    const top = scopeIds.length - 1;
    if (top < 0 || scopeIds[top] !== scopeId) {
      const actual = top < 0 ? "empty" : scopeIds[top];
      throw new Error(`[makeJitObservers] ${op}(${scopeId}) but stack top is ${actual}`);
    }
    return top;
  }

  return {
    observeScopeCall: (scopeId) => {
      const unit = worklist.locate.functionById(scopeId);
      const provenanceChain = unit !== undefined ? worklist.futureDispatchChainFor(unit) : ROOT_CONTEXT;
      scopeIds.push(scopeId);
      chains.push(provenanceChain);
      worklist.bump(runtimeCallCounter, scopeId);
    },
    observeScopeReturn: (scopeId, value) => {
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
