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
  canInstall?(scopeKey: StmtNS.FileInput | StmtNS.FunctionDef): boolean;

  /**
   * Produce the delta between the pre-transform and post-transform
   * materialized forms of `unit`.
   */
  computeDelta(unit: FunctionUnit): Delta;

  /**
   * Install the delta. Called when the scope is not pinned, OR when the
   * scope is pinned and `canInstallOnStack(scopeKey)` returned true.
   */
  applyDelta(scopeKey: StmtNS.FileInput | StmtNS.FunctionDef, delta: Delta): void;

  /**
   * Pin-gate layer 2/3 (strategy level — "is this state-delta install
   * technique safe against a live frame?"). Deny-by-default: if absent,
   * `OSRCoordinator.onChange` treats the pinned scope as an unconditional
   * skip. An explicit `true` return is the opt-in.
   *
   * Return true if installing this strategy's delta for `scopeKey` is safe
   * while a frame of `scopeKey` is live on the stack. For SVML
   * whole-function recompile: safe because `CallFrame` holds a direct IR
   * reference (not an indirection through `program.functions[i]`), so the
   * old IR executes to completion while new calls dispatch through the
   * patched slot. For in-place operand patches that mutate the same typed
   * arrays a live frame is reading from: NOT safe — omit or return false.
   *
   * Without this, a recursive workload (fib) never installs a specialized
   * version of itself during a single execution: the scope is pinned from
   * outermost entry to outermost return, so `onChange` skips every
   * notification until after the program finishes.
   *
   * Sister layers (see `ScopeTransformRule.safeOnStack` for the full
   * three-layer model): this layer answers "is the installation technique
   * safe?"; the rule-level flag answers "is the transform source safe?";
   * the engine-level `patchFunction`'s `allowOnStack` arg is the bypass
   * switch the strategy pulls after checking both prior answers. Absent
   * this layer, `OSRCoordinator` would have to trust the engine layer's
   * defense alone, which is insufficient for operand-patch strategies
   * (those mutate live-read typed arrays).
   */
  canInstallOnStack?(scopeKey: StmtNS.FileInput | StmtNS.FunctionDef): boolean;
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

  get stats() {
    return Object.freeze({
      notificationsSeen: this._notificationsSeen,
      skippedPinned: this._skippedPinned,
      skippedCanInstall: this._skippedCanInstall,
      skippedNoUnit: this._skippedNoUnit,
      installsFired: this._installsFired,
    });
  }

  private onChange(changed: ReadonlySet<StmtNS.FileInput | StmtNS.FunctionDef>): void {
    for (const key of changed) {
      this._notificationsSeen++;
      if (this.reactive.isScopeActive(key)) {
        // Deny-by-default: an absent `canInstallOnStack` means the strategy
        // has not opted in, so we skip. The predicate must be BOTH defined
        // AND return true for an on-stack install to proceed — `?.true`
        // shorthand would silently accept strategies that only forgot to
        // override the hook.
        const canInstall = this.strategy.canInstallOnStack;
        if (!canInstall || !canInstall.call(this.strategy, key)) {
          this._skippedPinned++;
          continue;
        }
        // fallthrough: strategy explicitly accepts on-stack install.
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
