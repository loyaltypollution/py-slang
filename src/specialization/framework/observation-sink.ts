// Narrow push-side interface the CSE interpreter depends on. Keeps engines
// decoupled from PersistentWorklist.

import type { ExprNS } from "../../ast-types";
import type { ScopeKey } from "./function-unit";

export interface ObservationSink {
  observeWrite(scopeKey: ScopeKey, rhsNode: ExprNS.Expr, rawValue: unknown): void;
  observeCall(scopeKey: ScopeKey, calleeKey: ScopeKey): void;
  activateScope(key: ScopeKey): void;
  deactivateScope(key: ScopeKey): void;
}
