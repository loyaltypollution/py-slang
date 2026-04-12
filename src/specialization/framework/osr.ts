// src/specialization/framework/osr.ts — OSR (on-stack replacement) coordinator
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
 * Pluggable code-swap backend. `recompile` is called synchronously on each
 * notification for changed, non-active scopes; `install` atomically replaces
 * the running code for that scope. The OSR safepoint contract (the worklist's
 * activeScopes pinning) guarantees `install` is never called while a scope's
 * code is currently executing.
 */
export interface CodeSwapStrategy<Code> {
  /**
   * Optional pre-filter. Return false to signal that `scopeKey` cannot be
   * hot-swapped by this strategy (e.g. the program entry for SVML, which is
   * rebuilt whole-program rather than per-function). When false, the
   * coordinator skips both `recompile` and `install` for this scope.
   */
  canInstall?(scopeKey: StmtNS.FileInput | StmtNS.FunctionDef): boolean;
  recompile(unit: FunctionUnit): Code;
  install(scopeKey: StmtNS.FileInput | StmtNS.FunctionDef, code: Code): void;
}

/** Degenerate strategy: AST is canonical (CSE case). `install` is a no-op. */
export class NoopSwapStrategy implements CodeSwapStrategy<void> {
  recompile(_unit: FunctionUnit): void {
    return;
  }
  install(_scopeKey: StmtNS.FileInput | StmtNS.FunctionDef, _code: void): void {
    /* no-op */
  }
}

/**
 * Subscribes to the worklist and drives the swap strategy. For each changed
 * scope: if active (pinned), skip — the worklist will re-notify after
 * deactivate, because transforms on pinned scopes are parked until the scope
 * becomes inactive (see persistent-worklist.ts hasProcessableTransform).
 * If inactive: recompile and install.
 */
export interface OSRStats {
  readonly notificationsSeen: number;
  readonly skippedPinned: number;
  readonly skippedCanInstall: number;
  readonly skippedNoUnit: number;
  readonly installsFired: number;
}

export class OSRCoordinator<Code> {
  private unsubscribe: (() => void) | null = null;

  private _notificationsSeen = 0;
  private _skippedPinned = 0;
  private _skippedCanInstall = 0;
  private _skippedNoUnit = 0;
  private _installsFired = 0;

  constructor(
    private readonly reactive: PersistentWorklist,
    private readonly strategy: CodeSwapStrategy<Code>,
  ) {}

  start(): () => void {
    if (this.unsubscribe) return this.unsubscribe;
    this.unsubscribe = this.reactive.subscribe(changed => this.onChange(changed));
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

  private onChange(changed: ReadonlySet<StmtNS.FileInput | StmtNS.FunctionDef>): void {
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
      const code = this.strategy.recompile(unit);
      this.strategy.install(key, code);
      this._installsFired++;
    }
  }
}
