// Generic unit-domain contract — the abstraction the worklist depends on
// when it needs to talk about the framework's atomic specialization entity
// without assuming `Function`.
//
// `Function` is the only concrete `Unit` today; `FunctionManager` is the
// only concrete `UnitDomain`. The split exists so generic worklist code
// (lifecycle replay, chain change, refute fan-out, rebuild orchestration)
// can route through this contract instead of through function-specific
// methods, leaving room for future unit kinds (loop, block, trace) without
// changing the framework.

import type { AssumptionChain } from "../assumption";
import type { NodeId, UnitExtent } from "../program/node-set";

/** Minimum program-shape lookup surface generic framework code needs:
 *  given a node id, find the owning unit (used by observation ingress'
 *  default unit resolver and by `futureDispatchChainForNode`).
 *
 *  Concrete locators (e.g. `FunctionLocator`) may expose richer queries
 *  (`functionById`, `blockContaining`, …) for analyses/transforms; those
 *  belong to the consumer-specific surface, not to `UnitLocator<U>`. */
export interface UnitLocator<U> {
  unitContainingNode(nodeId: NodeId): U | undefined;
}

export type ExtentChangeListener<U> = (
  unit: U,
  prev: UnitExtent,
  next: UnitExtent,
) => void;

export type ChainChangeListener<U> = (
  unit: U,
  prev: AssumptionChain,
  next: AssumptionChain,
) => void;

export type RefuteListener<U> = (unit: U, carrier: AssumptionChain) => void;

/** The lifecycle / speculation / scheduling contract for one unit kind.
 *
 *  All three lifecycle streams (`onExtentChange`, `onChainChange`,
 *  `onRefute`) are subscribe-once + replay-or-not-as-documented-by-each.
 *  The extent stream replays existing units at subscribe time with
 *  `prev = EMPTY_NODESET`; the chain stream and refute stream do not
 *  replay (they only fire on subsequent events).
 *
 *  Rebuild is two-phase: `scheduleRebuild(unit)` records intent;
 *  `flushPendingRebuilds()` materializes the change, fires the extent
 *  stream with non-empty (prev, next), and returns the units that were
 *  actually rebuilt (in flush order). */
export interface UnitDomain<U, L extends UnitLocator<U>> {
  /** The program-shape lookup surface concrete to this domain. */
  readonly locator: L;

  /** Live iteration over registered units. The framework treats the
   *  result as a snapshot for the duration of one consumer call. */
  values(): Iterable<U>;

  /** Snapshot of `unit`'s current extent. Same shape as the `next`
   *  payload on the extent stream. */
  extentOf(unit: U): UnitExtent;

  onExtentChange(cb: ExtentChangeListener<U>): void;

  chainFor(unit: U): AssumptionChain;
  onChainChange(cb: ChainChangeListener<U>): void;
  onRefute(cb: RefuteListener<U>): void;

  scheduleRebuild(unit: U): void;
  flushPendingRebuilds(): readonly U[];
}
