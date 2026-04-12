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
  private readonly pinSet: Map<StmtNS.FileInput | StmtNS.FunctionDef, number>;
  private coordinator: OSRCoordinator<unknown> | null = null;
  private converged = false;

  /**
   * Optional `pinSet` injection: when the evaluator already owns a
   * live-frame ref-count map (CSE's `context.runtime.pinSet`, SVML's
   * frame-anchored map), pass it here so the worklist and the engine
   * share a single source of truth. Omit for standalone usage (tests,
   * non-engine drivers); the engine creates its own.
   */
  constructor(
    ast: StmtNS.FileInput,
    environments: FunctionEnvironments,
    pinSet?: Map<StmtNS.FileInput | StmtNS.FunctionDef, number>,
  ) {
    this.pinSet = pinSet ?? new Map();
    this.worklist = new PersistentWorklist(
      ast,
      environments,
      createAnalyses(),
      createTransforms(),
      this.pinSet,
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
    } catch (e) {
      // An in-flight exception leaves the pin-set dirty: CSE does not
      // pop envs during JS-stack unwind, so any FunctionDef envs still
      // on `context.runtime.environments` never ran their leave-hook.
      // Rather than trying to reconstruct the correct set, reset — the
      // execution is aborted anyway, next run starts from scratch.
      this.pinSet.clear();
      throw e;
    } finally {
      stop();
    }
  }
}
