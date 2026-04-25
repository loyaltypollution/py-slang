import type { StmtNS } from "../../ast-types";
import type { AssumptionChain } from "../assumption";
import type { FunctionId } from "../program/program-view";
import type { Function } from "../program/function";
import type { Worklist } from "../framework/worklist";
import { bodyToCompile, dispatchValid } from "../speculation/chain-dispatch";
import { makeJitObservers } from "./runtime-analyses";

export type DispatchOutcome =
  | { kind: "specialized"; unit: Function; body: readonly StmtNS.Stmt[] }
  | { kind: "baseline"; unit: Function }
  | { kind: "skip"; unit: Function };

export interface JitDispatch {
  onCall(scopeId: FunctionId, args: readonly unknown[]): DispatchOutcome | undefined;
  onReturn(scopeId: FunctionId, value: unknown): void;
}

export function makeJitDispatch(worklist: Worklist): JitDispatch {
  const observers = makeJitObservers(worklist);
  const isRefuted = (n: AssumptionChain) => worklist.isRefuted(n);
  return {
    onCall(scopeId, args) {
      observers.observeScopeCall(scopeId);
      const unit = worklist.functions.get(scopeId);
      if (unit === undefined) return undefined;
      for (let i = 0; i < args.length; i++) {
        observers.observeParamEntry(scopeId, i, args[i]);
      }
      worklist.sweepTransforms();
      const chain = observers.currentChainFor(scopeId);
      if (!dispatchValid(unit, chain, isRefuted)) return { kind: "skip", unit };
      const body = bodyToCompile(unit, chain, worklist, isRefuted);
      if (body === unit.body) return { kind: "baseline", unit };
      return { kind: "specialized", unit, body };
    },
    onReturn(scopeId, value) {
      observers.observeScopeReturn(scopeId, value);
    },
  };
}
