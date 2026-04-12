// src/specialization/framework/observation-sink.ts
//
// The narrow push-side interface that interpreters depend on. Keeps engines
// decoupled from ReactiveOptimization and PersistentWorklist.

import type { ExprNS } from "../../ast-types";
import type { ScopeKey } from "./function-unit";

/**
 * Observation sink exposed to runtime interpreters (e.g. the CSE machine).
 *
 * The interpreter pushes raw values; analysis modules registered with the
 * underlying worklist interpret them.
 */
export interface ObservationSink {
  /** A runtime value was stored at this RHS expression's result slot. */
  observeWrite(scopeKey: ScopeKey, rhsNode: ExprNS.Expr, rawValue: unknown): void;

  /** A closure was invoked. `calleeKey` is the callee's scope (FunctionDef/Lambda). */
  observeCall(scopeKey: ScopeKey, calleeKey: ScopeKey): void;

  /**
   * Pin a scope as currently executing, deferring transforms for it.
   * Must be balanced by `deactivateScope`. Reference-counted for recursion.
   */
  activateScope(key: ScopeKey): void;
  deactivateScope(key: ScopeKey): void;
}
