// Single JIT orchestrator. Owns observe-push → observe-params → sweep →
// chain → gate → body pipeline; consumers map the outcome to their own
// compile policy. Conductors and the test harness both construct one via
// `makeJitDispatch(worklist)` — one place for the sequencing, one place
// for the sweep-before-read discipline.

import type { StmtNS } from "../../ast-types";
import { bodyToCompile, dispatchValid } from "../speculation/chain-dispatch";
import type { FunctionId } from "../framework/analysis";
import type { Unit } from "../framework/function-unit";
import type { AssumptionChain } from "../assumption";
import { makeJitObservers } from "./runtime-analyses";
import type { Worklist } from "../framework/worklist";

/** Outcome of one dispatched CALL. `undefined` from `onCall` means the
 *  scope has no Unit in topology (no compilation to perform). */
export type DispatchOutcome =
  | { kind: "specialized"; unit: Unit; body: readonly StmtNS.Stmt[] }
  | { kind: "baseline"; unit: Unit }
  | { kind: "skip"; unit: Unit };

export interface JitDispatch {
  onCall(scopeId: FunctionId, args: readonly unknown[]): DispatchOutcome | undefined;
  onReturn(scopeId: FunctionId, value: unknown): void;
}

export function makeJitDispatch(worklist: Worklist): JitDispatch {
  const observers = makeJitObservers(worklist);
  return {
    onCall(scopeId, args) {
      observers.observeScopeCall(scopeId);
      const unit = worklist.topology.unitOfFunctionId(scopeId);
      if (unit === undefined) return undefined;
      for (let i = 0; i < args.length; i++) {
        observers.observeParamEntry(scopeId, i, args[i]);
      }
      // Sweep before read: `publish`/`bump` deliberately skip the transform
      // sweep (see `bump` guard), so memoization and other runtime-gated
      // transforms stay dirty-but-unrun until drain. Reading the body first
      // would lower the unrewritten AST.
      worklist.sweepTransforms();
      const chain = observers.currentChainFor(scopeId);
      const isRefuted = (n: AssumptionChain) => worklist.isRefuted(n);
      if (!dispatchValid(unit, chain, isRefuted)) return { kind: "skip", unit };
      const body = bodyToCompile(unit, chain, worklist.topology, isRefuted);
      if (body === unit.body) return { kind: "baseline", unit };
      return { kind: "specialized", unit, body };
    },
    onReturn(scopeId, value) {
      observers.observeScopeReturn(scopeId, value);
    },
  };
}
