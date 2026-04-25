import type { AssumptionChain } from "../../assumption";
import type { SweepKind } from "../../framework/sweep-kind";
import type { Function } from "./function";
import type { FunctionManager } from "./function-manager";

/** `SweepKind<Function>` — the function-rooted transform sweep granularity.
 *  Thin wrapper over `FunctionManager` (mint/rebuild + schedulePendingRebuild)
 *  and `FunctionDispatchState` (chainFor). Function is presently the only
 *  root scheduling unit; a future Loop kind would ship its own SweepKind
 *  implementation alongside this one. */
export class FunctionSweepKind implements SweepKind<Function> {
  constructor(private readonly manager: FunctionManager) {}

  onMint(cb: (view: Function) => void): void {
    this.manager.onMint(cb);
  }

  onRebuild(cb: (view: Function) => void): void {
    this.manager.onRebuild(cb);
  }

  chainFor(view: Function): AssumptionChain {
    return this.manager.dispatch.futureDispatchChainFor(view);
  }

  scheduleRebuild(view: Function): void {
    this.manager.schedulePendingRebuild(view);
  }
}
