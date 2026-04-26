// Function-domain contract — the registry + lifecycle surface the worklist
// depends on. Chain and refute state used to live here too, but those are
// worklist-owned policy: the manager was a passive proxy with zero external
// consumers of those methods, so the state moved into Worklist directly.

import type { AssumptionChain } from "../assumption";
import type { FunctionExtent } from "../program/function-extent";
import type { Function } from "../program/function/function";
import type { FunctionLocator } from "../program/function/manager";

export type ExtentChangeListener = (
  unit: Function,
  prev: FunctionExtent,
  next: FunctionExtent,
) => void;

export type ChainChangeListener = (
  unit: Function,
  prev: AssumptionChain,
  next: AssumptionChain,
) => void;

export type RefuteListener = (unit: Function, carrier: AssumptionChain) => void;

/** Registry + lifecycle contract for the Function domain.
 *
 *  The extent stream replays existing units at subscribe time with
 *  `prev = EMPTY_NODESET`. Rebuild is two-phase: `scheduleRebuild(unit)`
 *  records intent; `flushPendingRebuilds()` materializes the change, fires
 *  the extent stream with non-empty (prev, next), and returns the units
 *  that were actually rebuilt (in flush order). */
export interface FunctionDomain {
  /** The program-shape lookup surface concrete to this domain. */
  readonly locator: FunctionLocator;

  /** Live iteration over registered units. The framework treats the
   *  result as a snapshot for the duration of one consumer call. */
  values(): Iterable<Function>;

  /** Snapshot of `unit`'s current extent. Same shape as the `next`
   *  payload on the extent stream. */
  extentOf(unit: Function): FunctionExtent;

  onExtentChange(cb: ExtentChangeListener): void;

  scheduleRebuild(unit: Function): void;
  flushPendingRebuilds(): readonly Function[];
}
