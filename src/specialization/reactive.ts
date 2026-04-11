// src/specialization/reactive.ts — reactive optimization API for JIT consumers

import type { StmtNS } from "../ast-types";
import type { FunctionEnvironments } from "../resolver";
import { ConstAnalysisModule } from "./const-analysis/analysis";
import type { ScopeKey, VersionedFunctionUnit } from "./framework/function-unit";
import { buildVersionedFunctionUnits } from "./framework/function-unit";
import type { AnalysisModule, TransformRule } from "./framework/interfaces";
import type { ExternalWorkItem, WorklistStats } from "./framework/persistent-worklist";
import { PersistentWorklist } from "./framework/persistent-worklist";
import { ConstantFoldingRule } from "./transforms/constant-folding";
import { DeadBranchEliminationRule } from "./transforms/dead-branch";
import { TypeAnalysisModule } from "./type-analysis/analysis";

export type { ScopeKey, VersionedFunctionUnit } from "./framework/function-unit";
export type { ExternalWorkItem, WorklistStats } from "./framework/persistent-worklist";

// ── Pipeline configuration (shared with optimize.ts) ────────────────────────

const ANALYSES: readonly AnalysisModule<any>[] = [new TypeAnalysisModule(), new ConstAnalysisModule()];
const TRANSFORMS: readonly TransformRule[] = [new DeadBranchEliminationRule(), new ConstantFoldingRule()];

// ── Subscription types ──────────────────────────────────────────────────────

export type ReactiveSubscriber = (changed: ReadonlySet<ScopeKey>) => void;

// ── ReactiveOptimization ────────────────────────────────────────────────────

export interface ReactiveOptimization {
  /** Current function units. Updated in-place by the worklist. */
  readonly units: ReadonlyMap<ScopeKey, VersionedFunctionUnit>;

  /** Subscribe to unit changes. Returns unsubscribe function. */
  subscribe(cb: ReactiveSubscriber): () => void;

  /**
   * Run to fixpoint (initial pass). Blocks synchronously until idle or
   * `maxRounds` transform rounds have fired.
   */
  converge(maxRounds?: number): void;

  /** Inject external work (runtime observations, scope invalidation). */
  enqueue(item: ExternalWorkItem): void;

  /**
   * Process pending work incrementally.
   * Returns true if any units changed during this tick.
   */
  tick(limit?: number): boolean;

  /** True when no work remains. */
  readonly idle: boolean;

  /** Worklist performance counters (accumulated across all drain/tick calls). */
  readonly stats: WorklistStats;

  /** Reset performance counters to zero. */
  resetStats(): void;
}

// ── Factory ─────────────────────────────────────────────────────────────────

/**
 * Create a reactive optimization session for JIT consumers.
 *
 * The returned object owns a PersistentWorklist that manages all scopes.
 * Call `converge()` for the initial static pass, then use `tick()` and
 * `enqueue()` for incremental updates driven by runtime observations.
 *
 * Subscribers are notified after each `tick()` or `converge()` that
 * produces changes.
 */
export function createReactiveOptimization(
  ast: StmtNS.FileInput,
  functionEnvironments: FunctionEnvironments,
): ReactiveOptimization {
  const units = buildVersionedFunctionUnits(ast, functionEnvironments);
  const worklist = new PersistentWorklist(ANALYSES, TRANSFORMS);

  for (const [key, unit] of units) {
    worklist.addScope(key, unit);
  }

  const subscribers = new Set<ReactiveSubscriber>();

  function notifySubscribers(changed: ReadonlySet<ScopeKey>): void {
    if (changed.size === 0) return;
    for (const cb of subscribers) cb(changed);
  }

  return {
    get units() {
      return units;
    },

    subscribe(cb: ReactiveSubscriber): () => void {
      subscribers.add(cb);
      return () => subscribers.delete(cb);
    },

    converge(maxRounds = 10): void {
      // Track total transform rounds across all scopes.
      // Each drain-to-idle constitutes one round (analysis + transforms).
      const allChanged = new Set<ScopeKey>();
      for (let round = 0; round <= maxRounds; round++) {
        const changed = worklist.drain();
        for (const key of changed) allChanged.add(key);
        if (worklist.idle) break;
      }
      notifySubscribers(allChanged);
    },

    enqueue(item: ExternalWorkItem): void {
      worklist.enqueue(item);
    },

    tick(limit?: number): boolean {
      const changed = worklist.drain(limit);
      notifySubscribers(changed);
      return changed.size > 0;
    },

    get idle(): boolean {
      return worklist.idle;
    },

    get stats(): WorklistStats {
      return worklist.stats;
    },

    resetStats(): void {
      worklist.resetStats();
    },
  };
}
