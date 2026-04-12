import type { ExprNS, StmtNS } from "../../ast-types";

/**
 * Narrow synchronous surface engines use to feed runtime observations
 * (writes, calls, scope push/pop) into the worklist. `PersistentWorklist`
 * implements this interface directly — the nominal name exists so test
 * mocks don't need to subtype the whole worklist.
 *
 * All four methods MUST be synchronous; `PersistentWorklist`'s constructor
 * runtime-asserts this because TypeScript treats `() => Promise<void>` as
 * assignable to `() => void`.
 */
export interface ObservationSink {
  observeWrite(
    scopeKey: StmtNS.FileInput | StmtNS.FunctionDef,
    rhsNode: ExprNS.Expr,
    rawValue: unknown,
  ): void;
  observeCall(
    scopeKey: StmtNS.FileInput | StmtNS.FunctionDef,
    calleeKey: StmtNS.FileInput | StmtNS.FunctionDef,
  ): void;
  activateScope(scope: StmtNS.FileInput | StmtNS.FunctionDef): void;
  deactivateScope(scope: StmtNS.FileInput | StmtNS.FunctionDef): void;
}
