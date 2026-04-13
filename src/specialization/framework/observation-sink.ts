import type { ExprNS, StmtNS } from "../../ast-types";

/**
 * Narrow synchronous surface engines use to feed runtime observations
 * (writes, calls) into the worklist. `Worklist` implements this interface
 * directly — the nominal name exists so test mocks don't need to subtype
 * the whole worklist.
 *
 * **Interpreter contract (LBD):** subscribers of this sink must late-bind
 * function bodies at call-entry — either by re-resolving the callee's
 * executable form at every CALL (CSE walks `closure.node.body` afresh per
 * call) or by snapshotting it into frame-local storage (SVML captures
 * `frame.ir` at CALL time and `patchFunction` swaps only the function-table
 * entry). Under LBD any body-local ABI-preserving transform is safe at any
 * time, which is why the worklist does not gate on pin state.
 *
 * All methods MUST be synchronous; `Worklist`'s constructor
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
}
