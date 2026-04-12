// src/specialization/framework/osr.ts — state-delta coordinator (OSR)
//
// Names and extracts the safepoint contract already implicit in
// PersistentWorklist's activateScope/deactivateScope pinning. The worklist
// leaves transforms for pinned scopes parked in its queue (see
// `hasProcessableTransform` / `processTransform` in persistent-worklist.ts) —
// this means when a pinned scope deactivates, the next `tick()` will fire the
// transform, which re-notifies subscribers. So the coordinator here only needs
// to ignore notifications for currently-active scopes; the worklist itself is
// the pending queue.

import type { StmtNS } from "../../ast-types";
import type { FunctionUnit } from "./function-unit";
import type { PersistentWorklist } from "./persistent-worklist";

type Scope = StmtNS.FileInput | StmtNS.FunctionDef;

/**
 * Pluggable state-delta backend. For each worklist change targeting an
 * inactive (unpinned) scope, the coordinator asks the strategy to
 * `computeDelta(unit)` and then `applyDelta(scopeKey, delta)`. `Delta` is
 * fully opaque to the framework — each engine picks the shape that matches
 * its materialized form:
 *
 *   - CSE: `Delta = void`. The transform already wrote through to the AST
 *     (the materialized form); there is nothing to install. See
 *     `InPlaceASTStrategy` below — `applyDelta` is a no-op by design, not by
 *     absence of feature.
 *   - SVML (whole-function): `Delta = { kind: 'whole', ir: SVMLIR }`. The
 *     strategy recompiles the unit and the interpreter patches the function
 *     table.
 *   - SVML (operand-level): `Delta = { kind: 'patches', patches: [...] }`.
 *     The strategy emits a minimal set of (pc, opcode/operand) edits and the
 *     interpreter mutates the existing typed arrays in place.
 *
 * The coordinator doesn't care which; it just sequences compute→apply inside
 * the pin-set gate.
 *
 * The OSR safepoint contract (PersistentWorklist's activeScopes pinning)
 * guarantees `applyDelta` is never called while a frame of the target scope
 * is on the stack.
 */
export interface StateDeltaStrategy<Delta> {
  /**
   * Optional pre-filter. Return false to signal that `scopeKey` cannot be
   * patched by this strategy (e.g. the program entry for SVML, which is
   * rebuilt whole-program rather than per-function). When false, the
   * coordinator skips both `computeDelta` and `applyDelta` for this scope.
   */
  canInstall?(scopeKey: Scope): boolean;

  /**
   * Produce the delta between the pre-transform and post-transform
   * materialized forms of `unit`.
   */
  computeDelta(unit: FunctionUnit): Delta;

  /**
   * Install the delta. Called only when the scope is not pinned.
   */
  applyDelta(scopeKey: Scope, delta: Delta): void;
}

/**
 * Degenerate strategy for engines whose materialized form IS the AST (CSE).
 * The transform already mutated the AST in place during `tick`, so the delta
 * is `void` and `applyDelta` is a no-op — not because the feature is absent,
 * but because the delta was already applied at the transform call site.
 */
export class InPlaceASTStrategy implements StateDeltaStrategy<void> {
  computeDelta(_unit: FunctionUnit): void {
    return;
  }
  applyDelta(_scopeKey: Scope, _delta: void): void {
    /* no-op */
  }
}

export interface OSRStats {
  readonly notificationsSeen: number;
  readonly skippedPinned: number;
  readonly skippedCanInstall: number;
  readonly skippedNoUnit: number;
  readonly installsFired: number;
}

/**
 * Subscribes to the worklist and drives the state-delta strategy. For each
 * changed scope: if active (pinned), skip — the worklist will re-notify
 * after deactivate, because transforms on pinned scopes are parked until the
 * scope becomes inactive. If inactive: computeDelta + applyDelta.
 */
export class OSRCoordinator<Delta> {
  private unsubscribe: (() => void) | null = null;

  private _notificationsSeen = 0;
  private _skippedPinned = 0;
  private _skippedCanInstall = 0;
  private _skippedNoUnit = 0;
  private _installsFired = 0;

  constructor(
    private readonly reactive: PersistentWorklist,
    private readonly strategy: StateDeltaStrategy<Delta>,
  ) {}

  start(): () => void {
    if (!this.unsubscribe) {
      this.unsubscribe = this.reactive.subscribe(changed => this.onChange(changed));
    }
    return () => this.stop();
  }

  stop(): void {
    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = null;
    }
  }

  get stats(): OSRStats {
    return Object.freeze({
      notificationsSeen: this._notificationsSeen,
      skippedPinned: this._skippedPinned,
      skippedCanInstall: this._skippedCanInstall,
      skippedNoUnit: this._skippedNoUnit,
      installsFired: this._installsFired,
    });
  }

  private onChange(changed: ReadonlySet<Scope>): void {
    for (const key of changed) {
      this._notificationsSeen++;
      if (this.reactive.isScopeActive(key)) {
        this._skippedPinned++;
        continue;
      }
      if (this.strategy.canInstall && !this.strategy.canInstall(key)) {
        this._skippedCanInstall++;
        continue;
      }
      const unit = this.reactive.units.get(key);
      if (!unit) {
        this._skippedNoUnit++;
        continue;
      }
      const delta = this.strategy.computeDelta(unit);
      this.strategy.applyDelta(key, delta);
      this._installsFired++;
    }
  }
}
