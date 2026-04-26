import type { StmtNS } from "../../ast-types";
import type { AssumptionChain } from "../assumption";
import type { Function, FunctionId } from "../program/function/function";
import type { FunctionLocator } from "../program/function/manager";
import { bodyToCompile, dispatchValid } from "../speculation/chain-dispatch";
import { makeJitObservers, type JitObservationRuntime } from "./runtime-analyses";

export interface DispatchPlan {
  readonly function: Function;
  readonly body?: readonly StmtNS.Stmt[];
}

export interface JitDispatch {
  onCall(scopeId: FunctionId, args: readonly unknown[]): DispatchPlan | undefined;
  onReturn(scopeId: FunctionId, value: unknown): void;
}

export interface JitDispatchRuntime extends JitObservationRuntime<Function> {
  readonly locate: FunctionLocator;
  isRefuted(context: AssumptionChain): boolean;
  sweepTransforms(): boolean;
}

export function makeJitDispatch(runtime: JitDispatchRuntime): JitDispatch {
  const observers = makeJitObservers(runtime);

  function isRefuted(context: AssumptionChain): boolean {
    return runtime.isRefuted(context);
  }

  function onCall(scopeId: FunctionId, args: readonly unknown[]): DispatchPlan | undefined {
    observers.observeScopeCall(scopeId);

    const function = runtime.locate.functionById(scopeId);
    if (function === undefined) {
      return undefined;
    }

    for (let i = 0; i < args.length; i++) {
      observers.observeParamEntry(scopeId, i, args[i]);
    }

    runtime.sweepTransforms();

    const chain = observers.currentChainFor(scopeId);
    if (!dispatchValid(function, chain, isRefuted)) {
      return { function };
    }

    const body = bodyToCompile(function, chain, runtime.locate, isRefuted);
    if (body === function.body) {
      return { function };
    }

    return { function, body };
  }

  function onReturn(scopeId: FunctionId, value: unknown): void {
    observers.observeScopeReturn(scopeId, value);
  }

  return {
    onCall,
    onReturn,
  };
}
