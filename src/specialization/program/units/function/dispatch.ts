// Per-Function speculation-policy state. Owns the
// `futureDispatchContext` map (preferred chain for the next
// compile/dispatch of each unit) and the chain-change / refute fan-out.
// Deliberately split from FunctionManager's registry/lifecycle/locator
// concerns: a Function's "what chain do we want to dispatch under" is
// orthogonal to its "what nodes does it own".

import { ROOT_CONTEXT, type AssumptionChain } from "../../../assumption";
import type { Function } from "./function";

export type ChainListener = (
  unit: Function,
  prev: AssumptionChain,
  next: AssumptionChain,
) => void;

export class FunctionDispatchState {
  /** Per-unit preferred chain for future compiles/dispatches. Unset or
   *  ROOT_CONTEXT means future dispatch is unspecialized. */
  private readonly futureDispatchContextByUnit = new Map<Function, AssumptionChain>();

  private readonly chainSubs: ChainListener[] = [];
  private readonly refuteSubs: Array<(unit: Function, carrier: AssumptionChain) => void> = [];

  futureDispatchChainFor(unit: Function): AssumptionChain {
    return this.futureDispatchContextByUnit.get(unit) ?? ROOT_CONTEXT;
  }

  setFutureDispatchContext(unit: Function, chain: AssumptionChain): void {
    this.futureDispatchContextByUnit.set(unit, chain);
  }

  clearFutureDispatchContext(unit: Function): void {
    this.futureDispatchContextByUnit.delete(unit);
  }

  /** Sole chain-stream primitive. Fires when a unit's preferred future-
   *  dispatch chain changes. Distinct from `onRefute`, which signals a
   *  specific carrier was refuted regardless of any unit's preference. */
  onChainChange(cb: ChainListener): void {
    this.chainSubs.push(cb);
  }

  fireChainChange(unit: Function, prev: AssumptionChain, next: AssumptionChain): void {
    for (const sub of this.chainSubs) sub(unit, prev, next);
  }

  onRefute(cb: (unit: Function, carrier: AssumptionChain) => void): void {
    this.refuteSubs.push(cb);
  }

  /** Fire refute subscribers for `(unit, carrier)`. Does not touch
   *  futureDispatchContext — the worklist owns the reconcile decision
   *  (clear-if-refuted) so the framework keeps fire and reconcile
   *  separable. */
  fireRefute(unit: Function, carrier: AssumptionChain): void {
    for (const sub of this.refuteSubs) sub(unit, carrier);
  }
}
