// The publication boundary — between the specialization framework and the
// execution layer that compiles and publishes its results.
//
// The framework decides "this unit's preferred chain has changed; rebuild
// it." The execution layer decides "what compiled artifact corresponds to
// this unit, and when does executing code observe the change?" These are
// separate questions, and conflating them is what makes OSR look harder
// than it is.
//
// Question 1 — what unit do we analyze / transform / reschedule?
//     → answered by `UnitDomain` (`framework/unit-domain.ts`).
//
// Question 2 — what artifact gets published, and at what safe point?
//     → answered by an implementation of `PublicationStrategy`, owned by
//       the execution layer (today: `engines/svml`, via the JIT dispatch
//       hook in `PySvmlJitEvaluator`).
//
// Today the only concrete strategy is `"per-call"`: every CALL recompiles
// the chosen unit against its live preferred chain and the new frame
// captures the resulting artifact directly. No slot patching, no OSR.
// `SVMLInterpreter.patchFunction` is a dormant hook intended for a future
// `"slot-patch"` strategy; introducing it would not require any framework
// change, only a different `PublicationStrategy` implementation that
// drives `worklist.drain()` ahead of execution and patches slots between
// runs.
//
// `"osr"` is the genuinely new design: current frames observe the change
// mid-execution at named safe points. That requires the framework to
// expose a unit-extent diff that the execution layer can map onto a
// safe-point table. The current contract intentionally does not promise
// this; it promises only that future *dispatch* sees the new artifact.

import type { AssumptionChain } from "./assumption";

/** Visibility shape of a publication strategy — when does executing code
 *  observe a fresh compiled artifact?
 *
 *  - `"per-call"`: every CALL recompiles a unit against its live preferred
 *    chain; only the resulting frame sees the artifact. No state survives
 *    between calls. Current SVML JIT.
 *  - `"slot-patch"`: a recompiled artifact is installed into a fixed
 *    program slot atomically; future dispatches go through the new slot,
 *    while already-running frames continue on the IR they captured at
 *    CALL time. Requires no OSR. Dormant hook:
 *    `SVMLInterpreter.patchFunction`.
 *  - `"osr"`: current frames may switch to the new artifact mid-execution
 *    at named safe points. Requires a safe-point table and a frame
 *    re-materialization story that the current architecture does not
 *    have. */
export type PublicationGranularity = "per-call" | "slot-patch" | "osr";

/** The compile half of a publication strategy.
 *
 *  The framework supplies a unit and the chain that unit should be
 *  specialized under; the strategy produces the artifact the execution
 *  layer dispatches on. The strategy does NOT own *when* the artifact
 *  becomes visible — that is the engine's responsibility, encoded by
 *  `granularity`.
 *
 *  Today's only implementation lives behind SVML's
 *  `compiler.compileFunction(unit, body)`, with `granularity = "per-call"`.
 *
 *  The contract guarantees, regardless of granularity:
 *    - the framework does not observe the artifact `A` directly,
 *    - the engine does not observe the framework's `AssumptionChain`
 *      machinery directly,
 *    - the only thing crossing the boundary in either direction is the
 *      pair `(unit, chain)` going engine-ward and `A` coming back. */
export interface PublicationStrategy<U, A> {
  readonly granularity: PublicationGranularity;
  compile(unit: U, chain: AssumptionChain): A;
}
