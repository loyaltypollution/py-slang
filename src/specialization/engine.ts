// src/specialization/engine.ts — SpecializationEngine facade.
//
// Wraps PersistentWorklist + OSRCoordinator + default pipeline behind a
// single object so evaluators don't assemble the pieces themselves. Two-phase
// construction (create → installStrategy → run) accommodates SVML's
// SVMLSwapStrategy(compiler, interpreter) dependency on `units` being known
// first; engines with trivial install (CSE) skip installStrategy entirely and
// get the default InPlaceASTStrategy.

import type { ExprNS, StmtNS } from "../ast-types";
import type { FunctionEnvironments } from "../resolver";
import type { FunctionUnit } from "./framework/function-unit";
import type { OptimizationHint } from "./framework/hint";
import type { ObservationSink } from "./framework/observation-sink";
import { InPlaceASTStrategy, OSRCoordinator } from "./framework/osr";
import type { StateDeltaStrategy } from "./framework/osr";
import { PersistentWorklist } from "./framework/persistent-worklist";
import { createAnalyses, createTransforms } from "./pipeline-config";

export class SpecializationEngine {
  private readonly worklist: PersistentWorklist;
  private coordinator: OSRCoordinator<unknown> | null = null;
  private converged = false;

  private constructor(worklist: PersistentWorklist) {
    this.worklist = worklist;
  }

  static create(
    ast: StmtNS.FileInput,
    environments: FunctionEnvironments,
  ): SpecializationEngine {
    const worklist = new PersistentWorklist(
      ast,
      environments,
      createAnalyses(),
      createTransforms(),
    );
    return new SpecializationEngine(worklist);
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
   * Direct worklist access for tests and tooling that need to drive the
   * reactive loop manually (tick, subscribe, stats). Production code should
   * prefer `run()` for the full lifecycle.
   */
  get worklistForAdvancedUse(): PersistentWorklist {
    return this.worklist;
  }

  /**
   * Install the state-delta strategy. For SVML this is called after compiler
   * + interpreter are constructed (SVMLSwapStrategy captures both). For CSE
   * with AST-in-place semantics, skip this — `run()` installs a default
   * `InPlaceASTStrategy` if none was set. Calling again replaces the previous
   * strategy and restarts the coordinator subscription.
   */
  installStrategy<Delta>(strategy: StateDeltaStrategy<Delta>): void {
    if (this.coordinator) this.coordinator.stop();
    this.coordinator = new OSRCoordinator(
      this.worklist,
      strategy as StateDeltaStrategy<unknown>,
    );
  }

  /**
   * Pin `rootScope`, start the coordinator (installing a default
   * `InPlaceASTStrategy` if none installed), run `fn`, then stop the
   * coordinator and unpin. Asserts `converge()` has run.
   */
  async run<T>(
    rootScope: StmtNS.FileInput | StmtNS.FunctionDef,
    fn: () => Promise<T> | T,
  ): Promise<T> {
    if (!this.converged) {
      throw new Error("SpecializationEngine.run called before converge()");
    }
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
