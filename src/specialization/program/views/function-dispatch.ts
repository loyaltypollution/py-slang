// Per-Function speculation-policy state. Owns the
// `futureDispatchContext` map (preferred chain for the next
// compile/dispatch of each unit) and the spec-rev / refute fan-out.
// Deliberately split from FunctionManager's registry/lifecycle/locator
// concerns: a Function's "what chain do we want to dispatch under" is
// orthogonal to its "what nodes does it own" — conflating them was the
// reason `dfa-query` had to duck-type future-dispatch off a registry
// interface.

import { ROOT_CONTEXT, type AssumptionChain } from "../../assumption";
import type { Refutations } from "../../assumption/refutation";
import type { Function } from "./function";

export class FunctionDispatchState {
  /** Per-unit preferred chain for future compiles/dispatches. Unset or
   *  ROOT_CONTEXT means future dispatch is unspecialized. */
  private readonly futureDispatchContextByUnit = new Map<Function, AssumptionChain>();

  private readonly specRevSubs: Array<(unit: Function) => void> = [];
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

  onSpecRev(cb: (unit: Function) => void): void {
    this.specRevSubs.push(cb);
  }

  fireSpecRev(unit: Function): void {
    for (const sub of this.specRevSubs) sub(unit);
  }

  onRefute(cb: (unit: Function, carrier: AssumptionChain) => void): void {
    this.refuteSubs.push(cb);
  }

  /** Refute `carrier` for `unit`: fire refute subscribers, then drop the
   *  unit's futureDispatchContext entry if it's now refuted. */
  fireRefuteAndReconcile(
    unit: Function,
    carrier: AssumptionChain,
    refutations: Refutations,
  ): void {
    for (const sub of this.refuteSubs) sub(unit, carrier);
    const fdCtx = this.futureDispatchContextByUnit.get(unit);
    if (fdCtx !== undefined && refutations.contains(fdCtx)) {
      this.futureDispatchContextByUnit.delete(unit);
    }
  }
}
