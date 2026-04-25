import type { AssumptionChain } from "../../assumption";
import type { SweepKind } from "../../framework/sweep-kind";
import type { Function } from "./function";
import type { FunctionManager } from "./function-manager";

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
