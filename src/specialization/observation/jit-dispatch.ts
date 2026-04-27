import type { StmtNS } from "../../ast-types";
import type { AssumptionChain } from "../assumption";
import type { Function, FunctionId } from "../program/function/function";
import type { FunctionLocator } from "../program/function/manager";
import { bodyToCompile, dispatchValid } from "../speculation/chain-dispatch";
import { makeJitObservers, type JitObservationRuntime } from "./runtime-analyses";

export interface DispatchPlan {
  readonly unit: Function;
  readonly body?: readonly StmtNS.Stmt[];
}

export interface JitDispatch {
  onCall(scopeId: FunctionId, args: readonly unknown[]): DispatchPlan | undefined;
  onReturn(scopeId: FunctionId, value: unknown): void;
}

export interface JitDispatchRuntime extends JitObservationRuntime<Function> {
  readonly locate: FunctionLocator;
  isRefuted(context: AssumptionChain): boolean;
  drain(): readonly Function[];
}

export function makeJitDispatch(runtime: JitDispatchRuntime): JitDispatch {
  const observers = makeJitObservers(runtime);

  function onCall(scopeId: FunctionId, args: readonly unknown[]): DispatchPlan | undefined {
    observers.observeScopeCall(scopeId);

    const unit = runtime.locate.functionById(scopeId);
    if (unit === undefined) {
      return undefined;
    }

    for (let i = 0; i < args.length; i++) {
      observers.observeParamEntry(scopeId, i, args[i]);
    }

    runtime.drain();

    const chain = observers.currentChainFor(scopeId);
    if (runtime.isRefuted(chain) || !dispatchValid(unit, chain)) {
      return { unit };
    }

    const body = bodyToCompile(unit, chain, runtime.locate);
    if (body === unit.body) {
      return { unit };
    }

    return { unit, body };
  }

  function onReturn(scopeId: FunctionId, value: unknown): void {
    observers.observeScopeReturn(scopeId, value);
  }

  return {
    onCall,
    onReturn,
  };
}
