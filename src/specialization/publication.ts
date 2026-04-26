// The publication boundary — between the specialization framework and
// the execution layer that compiles and publishes its results.
//
// CONTRACT: Function is the only swap unit, function-entry the only
// swap channel. Specialized bodies become visible to executing code
// strictly at the next CALL — never mid-frame, never at a back-edge,
// never to a frame already running. In-flight frames continue under
// whatever body they were dispatched with.
//
// This is not a temporary cap. Sub-function code replacement requires
// OSR machinery (PC↔AST mapping, stack-empty safe points, generation-
// tracked IR refs, frame migration). The CSE backend could plausibly
// support it; SVML cannot without internal-VM work. Until both backends
// have ratified an OSR contract, every part of the framework that
// touches publication assumes "Function only, next-call only."
//
// Adding a second swap unit kind, or any mid-frame swap channel,
// requires changing both this file's contract AND each backend's
// runtime. It is not a glue-layer change. Resist the temptation to
// generalize this interface in anticipation.
//
//   Q1 — what unit do we analyze / transform / reschedule?
//        → Function. See `framework/unit-domain.ts`.
//
//   Q2 — what artifact gets published, and when?
//        → answered by an implementation of `FunctionSwapStrategy`,
//          dependency-injected by the execution layer (today:
//          `engines/svml`, via the `dispatchCall` closure in
//          `PySvmlJitEvaluator`). Each invocation derives the chosen
//          body under the live preferred chain, compiles it, and the
//          new frame captures the artifact directly.

import type { AssumptionChain } from "./assumption";
import type { Function } from "./program/units/function";

/** The compile half of the publication boundary.
 *
 *  The framework hands the strategy a `(func, chain)` pair and receives
 *  back an artifact `A` the execution layer dispatches on. `A` is
 *  backend-specific — `SVMLIR` for SVML, `Stmt[]` for CSE — and the
 *  framework never observes it.
 *
 *  Today's only implementation is the closure inside
 *  `PySvmlJitEvaluator.dispatchCall`, where `A = SVMLIR`. */
export interface FunctionSwapStrategy<A> {
  compile(func: Function, chain: AssumptionChain): A;
}
