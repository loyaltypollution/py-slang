// Narrow push-side interface the CSE interpreter depends on. Keeps engines
// decoupled from PersistentWorklist.
//
// SYNCHRONY INVARIANT: All methods return `void`, not `Promise<void>`.
// Observation emission is a synchronous sub-call of the interpreter step
// that produced it — `observeWrite/observeCall` enqueue work and
// `rebuildAndReseed` is synchronous; `activate/deactivateScope` mutate the
// pin-set in place. The OSR safepoint contract (transforms on pinned scopes
// parked until deactivation) rests on this synchrony: if any implementation
// returned a Promise, an interpreter step could observe and then yield the
// event loop while holding a pin, allowing a concurrent tick to see stale
// state. Implementations MUST be synchronous.
//
// TypeScript caveat: the compiler treats `() => Promise<void>` as
// assignable to `() => void`, so the `void` return type below is not
// sufficient on its own to reject async implementations. The construction-
// time assertion `assertSyncObservationSink` (called from
// `SpecializationEngine.create` on the worklist sink) catches the common
// case: methods declared `async function`/`async () => ...`, detected via
// `constructor.name === "AsyncFunction"`.
//
// What it does NOT catch: a plain function that returns `Promise.resolve()`
// explicitly, or a transpiled async method whose native constructor is
// `Function` or `GeneratorFunction`. A defensive wrapper that inspects
// every call's return value would work but adds a thenable check on the
// observation hot path; we consider the construction-time guard an
// adequate tripwire for the mistake we're actually worried about (someone
// writing `async observeWrite` and not realizing TS accepted it). Callers
// constructing a sink that synthesizes Promises by hand are doing so
// deliberately and are outside the tripwire's scope.

import type { ExprNS, StmtNS } from "../../ast-types";

export interface ObservationSink {
  observeWrite(scopeKey: StmtNS.FileInput | StmtNS.FunctionDef, rhsNode: ExprNS.Expr, rawValue: unknown): void;
  observeCall(scopeKey: StmtNS.FileInput | StmtNS.FunctionDef, calleeKey: StmtNS.FileInput | StmtNS.FunctionDef): void;
  activateScope(key: StmtNS.FileInput | StmtNS.FunctionDef): void;
  deactivateScope(key: StmtNS.FileInput | StmtNS.FunctionDef): void;
}

/**
 * Construction-time tripwire that rejects the common mistake of declaring
 * an `ObservationSink` method `async`. Inspects each method's runtime
 * constructor name and throws if it is `AsyncFunction`.
 *
 * Scope (explicit): catches `async function`/`async () => ...` declarations
 * before they wire into the engine. Does NOT catch plain functions that
 * return `Promise.resolve()` by hand — see the file-level comment. The
 * interface's `void` return type is the declared contract; this function
 * is a tripwire, not a sandbox.
 */
export function assertSyncObservationSink(sink: ObservationSink): void {
  const methods: Array<keyof ObservationSink> = [
    "observeWrite",
    "observeCall",
    "activateScope",
    "deactivateScope",
  ];
  for (const name of methods) {
    const fn = sink[name];
    if (typeof fn !== "function") {
      throw new Error(`ObservationSink.${name} is not a function`);
    }
    // A function whose declared return type is `Promise<T>` has an
    // `AsyncFunction` constructor at runtime; detect the class name.
    if (fn.constructor?.name === "AsyncFunction") {
      throw new Error(
        `ObservationSink.${name} must be synchronous; async implementations break the OSR safepoint contract`,
      );
    }
  }
}
