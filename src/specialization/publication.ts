// The publication boundary — between the specialization framework and
// the execution layer that compiles and publishes its results.
//
// The framework decides "this unit's preferred chain has changed; rebuild
// it." The execution layer decides "what compiled artifact corresponds
// to this unit, and when does executing code observe the change?" These
// are separate questions, and conflating them is what makes OSR look
// harder than it is.
//
//   Q1 — what unit do we analyze / transform / reschedule?
//        → answered by `UnitDomain` (`framework/unit-domain.ts`).
//
//   Q2 — what artifact gets published, and at what safe point?
//        → answered by an implementation of `PublicationStrategy`,
//          dependency-injected by the execution layer (today:
//          `engines/svml`, via the `dispatchCall` closure in
//          `PySvmlJitEvaluator`).
//
// Today's only strategy recompiles per CALL: each invocation derives the
// chosen body under the live preferred chain, calls
// `compiler.compileFunction(unit, body)`, and the new frame captures
// the resulting artifact directly. No slot patching, no OSR — the
// strategy is its own description.
//
// True OSR — current frames switching mid-execution at safe points — is
// out of scope. The current contract promises only that future *dispatch*
// sees the new artifact.

import type { AssumptionChain } from "./assumption";

/** The compile half of the publication boundary.
 *
 *  The framework hands the strategy a `(unit, chain)` pair and receives
 *  back an artifact `A` the execution layer dispatches on. The strategy
 *  is opaque to the framework — when artifacts become visible, what
 *  granularity is published, and what safe points (if any) are required
 *  are all inside the strategy implementation. The framework neither
 *  knows nor needs to.
 *
 *  Symmetric guarantees, kept tight on purpose:
 *    - the framework never observes `A`,
 *    - the strategy never observes the framework's `AssumptionChain`
 *      machinery beyond the value it was handed.
 *
 *  Today's only implementation is the closure inside
 *  `PySvmlJitEvaluator.dispatchCall`, where `A = SVMLIR`. */
export interface PublicationStrategy<U, A> {
  compile(unit: U, chain: AssumptionChain): A;
}
