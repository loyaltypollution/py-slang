// Narrow push-side interface the CSE interpreter depends on. Keeps engines
// decoupled from PersistentWorklist.

import type { ExprNS, StmtNS } from "../../ast-types";

export interface ObservationSink {
  observeWrite(scopeKey: StmtNS.FileInput | StmtNS.FunctionDef, rhsNode: ExprNS.Expr, rawValue: unknown): void;
  observeCall(scopeKey: StmtNS.FileInput | StmtNS.FunctionDef, calleeKey: StmtNS.FileInput | StmtNS.FunctionDef): void;
  activateScope(key: StmtNS.FileInput | StmtNS.FunctionDef): void;
  deactivateScope(key: StmtNS.FileInput | StmtNS.FunctionDef): void;
}
