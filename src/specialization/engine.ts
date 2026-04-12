// src/specialization/engine.ts — SpecializationEngine facade.
//
// Wraps PersistentWorklist + OSRCoordinator + default pipeline behind a
// single object so evaluators don't assemble the pieces themselves.
//
// Two-phase construction (new Engine → installStrategy → run) accommodates
// SVML's `SVMLSwapStrategy(compiler, interpreter)` dependency on `units`
// being known first: the compiler is built from `engine.units`, the
// interpreter from the compiler's program, and only then can the strategy
// be constructed. Engines with trivial install (CSE) skip `installStrategy`
// entirely and get a default `InPlaceASTStrategy`.

import type { ExprNS, StmtNS } from "../ast-types";
import type { FunctionEnvironments } from "../resolver";
import type { FunctionUnit } from "./framework/function-unit";
import type { OptimizationHint } from "./framework/hint";
import type { ObservationSink } from "./framework/persistent-worklist";
import { InPlaceASTStrategy, OSRCoordinator } from "./framework/osr";
import type { StateDeltaStrategy } from "./framework/osr";
import { PersistentWorklist } from "./framework/persistent-worklist";
import { createAnalyses, createTransforms } from "./pipeline-config";

export class SpecializationEngine {
  private readonly worklist: PersistentWorklist;
  private coordinator: OSRCoordinator<unknown> | null = null;
  private converged = false;

  constructor(ast: StmtNS.FileInput, environments: FunctionEnvironments) {
    this.worklist = new PersistentWorklist(
      ast,
      environments,
      createAnalyses(),
      createTransforms(),
    );
  }

  /** Run initial static analysis + transforms to fixpoint. Idempotent. */
  converge(): void {
    if (this.converged) return;
    this.worklist.converge();
    this.converged = true;
  }

  get units(): ReadonlyMap<StmtNS.FileInput | StmtNS.FunctionDef, FunctionUnit> {
    return this.worklist.units;
  }

  hintsFor(node: ExprNS.Expr | StmtNS.Stmt): OptimizationHint | undefined {
    return this.worklist.hintsFor(node);
  }

  /** Push-side interface the interpreter emits observations through. */
  get observationSink(): ObservationSink {
    return this.worklist;
  }

  /**
   * Install the state-delta strategy. For SVML this is called after the
   * compiler and interpreter are constructed (SVMLSwapStrategy captures
   * both). For CSE, skip this — `run()` installs a default
   * `InPlaceASTStrategy` if none was set. Calling again replaces the
   * previous strategy.
   */
  installStrategy<Delta>(strategy: StateDeltaStrategy<Delta>): void {
    if (this.coordinator) this.coordinator.stop();
    this.coordinator = new OSRCoordinator(
      this.worklist,
      strategy as StateDeltaStrategy<unknown>,
    );
  }

  /**
   * Converge (idempotent), pin `rootScope`, start the coordinator (with a
   * default `InPlaceASTStrategy` if none was installed), run `fn`, then
   * stop the coordinator and unpin.
   */
  async run<T>(rootScope: StmtNS.FileInput | StmtNS.FunctionDef, fn: () => Promise<T> | T): Promise<T> {
    this.converge();
    if (!this.coordinator) {
      this.coordinator = new OSRCoordinator(this.worklist, new InPlaceASTStrategy());
    }
    const stop = this.coordinator.start();
    try {
      return await this.worklist.withActiveScope(rootScope, fn);
    } finally {
      stop();
    }
  }
}
