// src/specialization/reactive.ts — reactive optimization API for JIT + OBSERVE consumers

import type { ExprNS, StmtNS } from "../ast-types";
import type { FunctionEnvironments } from "../resolver";
import type { ScopeKey, VersionedFunctionUnit } from "./framework/function-unit";
import { buildVersionedFunctionUnits } from "./framework/function-unit";
import type { ExternalWorkItem, WorklistStats } from "./framework/persistent-worklist";
import { PersistentWorklist } from "./framework/persistent-worklist";
import { createAnalyses, createTransforms } from "./pipeline-config";

export type { ScopeKey, VersionedFunctionUnit } from "./framework/function-unit";
export type { ExternalWorkItem, WorklistStats } from "./framework/persistent-worklist";

// ── Subscription types ──────────────────────────────────────────────────────

export type ReactiveSubscriber = (changed: ReadonlySet<ScopeKey>) => void;

// ── ReactiveOptimization ────────────────────────────────────────────────────

export interface ReactiveOptimization {
  /** Current function units. Updated in-place by the worklist. */
  readonly units: ReadonlyMap<ScopeKey, VersionedFunctionUnit>;

  /** Subscribe to unit changes. Returns unsubscribe function. */
  subscribe(cb: ReactiveSubscriber): () => void;

  /** Run to fixpoint (initial pass). Blocks synchronously until idle. */
  converge(): void;

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

  // ── OBSERVE loop API ──────────────────────────────────────────────────────

  /**
   * Monotonically-increasing version across all unit HintStores. Intended as
   * the scalar observable for `useSyncExternalStore`-style UI consumers.
   * Bumps whenever any scope's hints change (either from analysis or from
   * runtime observations).
   */
  readonly hintStoreVersion: number;

  /**
   * Push a runtime value written at `rhsNode` in `scopeKey`. Analysis modules
   * translate the raw value via `observeValue` and widen the hint via join.
   */
  observeWrite(scopeKey: ScopeKey, rhsNode: ExprNS.Expr, rawValue: unknown): void;

  /**
   * Push a function call observation. Currently equivalent to invalidating
   * `calleeKey`; future call-count analysis modules may consume it directly.
   */
  observeCall(scopeKey: ScopeKey, calleeKey: ScopeKey): void;

  /**
   * Pin a scope as active on an interpreter call stack. While pinned,
   * transforms for that scope are parked (not dequeued). Reference-counted
   * for recursion — match each `activateScope` with one `deactivateScope`.
   */
  activateScope(key: ScopeKey): void;
  deactivateScope(key: ScopeKey): void;
}

// ── Factory ─────────────────────────────────────────────────────────────────

/**
 * Create a reactive optimization session for JIT + OBSERVE-loop consumers.
 *
 * The returned object owns a PersistentWorklist that manages all scopes.
 * Call `converge()` for the initial static pass, then use `tick()`,
 * `observeWrite()`, and `observeCall()` for incremental runtime-driven updates.
 *
 * Subscribers are notified after each `tick()` or `converge()` that produces
 * changes.
 */
export function createReactiveOptimization(
  ast: StmtNS.FileInput,
  functionEnvironments: FunctionEnvironments,
): ReactiveOptimization {
  const units = buildVersionedFunctionUnits(ast, functionEnvironments);
  const worklist = new PersistentWorklist(createAnalyses(), createTransforms());

  for (const [key, unit] of units) {
    worklist.addScope(key, unit);
  }

  const subscribers = new Set<ReactiveSubscriber>();

  function notifySubscribers(changed: ReadonlySet<ScopeKey>): void {
    if (changed.size === 0) return;
    for (const cb of subscribers) cb(changed);
  }

  function computeHintVersion(): number {
    // Aggregate across all units. Monotonicity follows because each unit's
    // HintStore.version is itself monotonic and units are never removed.
    let sum = 0;
    for (const unit of units.values()) sum += unit.hints.version;
    return sum;
  }

  return {
    get units() {
      return units;
    },

    subscribe(cb: ReactiveSubscriber): () => void {
      subscribers.add(cb);
      return () => subscribers.delete(cb);
    },

    converge(): void {
      notifySubscribers(worklist.drain());
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

    get hintStoreVersion(): number {
      return computeHintVersion();
    },

    observeWrite(scopeKey: ScopeKey, rhsNode: ExprNS.Expr, rawValue: unknown): void {
      worklist.enqueue({
        kind: "value-observation",
        scopeKey,
        nodeId: rhsNode.id,
        value: rawValue,
      });
    },

    observeCall(scopeKey: ScopeKey, calleeKey: ScopeKey): void {
      worklist.enqueue({ kind: "call-observation", scopeKey, calleeKey });
    },

    activateScope(key: ScopeKey): void {
      worklist.activateScope(key);
    },

    deactivateScope(key: ScopeKey): void {
      worklist.deactivateScope(key);
    },
  };
}
