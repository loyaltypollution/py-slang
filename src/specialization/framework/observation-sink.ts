// Narrow push-side interface the CSE interpreter depends on. Keeps engines
// decoupled from PersistentWorklist.
//
// INVARIANT: All methods return `void`, not `Promise<void>`. Observation
// emission is a synchronous sub-call of the interpreter step that produced
// it — `observeWrite/observeCall` enqueue work and `rebuildAndReseed` is
// synchronous; `activate/deactivateScope` mutate the pin-set in place. The
// OSR safepoint contract (transforms on pinned scopes parked until
// deactivation) rests on this synchrony: if any implementation returned a
// Promise, an interpreter step could observe and then yield the event loop
// while holding a pin, allowing a concurrent tick to see stale state.
// Implementations MUST be synchronous.

import type { ExprNS, StmtNS } from "../../ast-types";

export interface ObservationSink {
  observeWrite(scopeKey: StmtNS.FileInput | StmtNS.FunctionDef, rhsNode: ExprNS.Expr, rawValue: unknown): void;
  observeCall(scopeKey: StmtNS.FileInput | StmtNS.FunctionDef, calleeKey: StmtNS.FileInput | StmtNS.FunctionDef): void;
  activateScope(key: StmtNS.FileInput | StmtNS.FunctionDef): void;
  deactivateScope(key: StmtNS.FileInput | StmtNS.FunctionDef): void;
}
