// Function-domain contract — the registry + lifecycle surface the worklist
// depends on. Chain and refute state are worklist-owned speculation policy,
// not part of this contract.

import type { Function } from "../program/function/function";
import type { FunctionLocator } from "../program/function/manager";

/** Lifecycle event for a unit. `isMint` is true for the subscribe-time
 *  replay of every existing unit and false for rebuilds. */
export type ExtentChangeListener = (unit: Function, isMint: boolean) => void;

/** Registry + lifecycle contract for the Function domain.
 *
 *  The extent stream replays existing units at subscribe time with
 *  `isMint = true`. Rebuild is two-phase: `scheduleRebuild(unit)` records
 *  intent; `flushPendingRebuilds()` materializes the change, fires the
 *  extent stream with `isMint = false`, and returns the units that were
 *  actually rebuilt (in flush order). */
export interface FunctionDomain {
  /** The program-shape lookup surface concrete to this domain. */
  readonly locator: FunctionLocator;

  /** Live iteration over registered units. The framework treats the
   *  result as a snapshot for the duration of one consumer call. */
  values(): Iterable<Function>;

  onExtentChange(cb: ExtentChangeListener): void;

  scheduleRebuild(unit: Function): void;
  flushPendingRebuilds(): readonly Function[];
}
