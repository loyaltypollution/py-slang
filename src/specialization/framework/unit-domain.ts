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
 *  default unit resolver).
 *
 *  Concrete locators (e.g. `FunctionLocator`) may expose richer queries
 *  (`functionById`, `blockContaining`, …) for analyses/transforms; those
 *  belong to the consumer-specific surface, not to `UnitLocator<U>`.
 *
 *  Used by the worklist's default observation-unit resolver. */
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

  // --- chain (preferred future-dispatch) ---

  /** Read `unit`'s preferred future-dispatch chain. Returns `ROOT_CONTEXT`
   *  when no preference is set. */
  chainFor(unit: U): AssumptionChain;
  /** Set the preferred future-dispatch chain for `unit`. Does NOT fire
   *  `onChainChange` on its own — observation ingress fires the chain
   *  delta explicitly so the (prev, next) pair is correct. */
  setChainFor(unit: U, chain: AssumptionChain): void;
  /** Drop any preferred future-dispatch chain for `unit`. */
  clearChainFor(unit: U): void;
  /** Subscribe to chain changes. */
  onChainChange(cb: ChainChangeListener<U>): void;
  /** Manually fire the chain stream — used by observation ingress after
   *  it has reconciled `setChainFor`/`clearChainFor` with the new chain. */
  fireChainChange(unit: U, prev: AssumptionChain, next: AssumptionChain): void;

  // --- refute (orthogonal to chain change) ---

  /** Subscribe to refutation events. The carrier identity is preserved —
   *  consumers like memoization need it. */
  onRefute(cb: RefuteListener<U>): void;
  /** Fire the refute stream for `unit` against `carrier`. Reconciliation
   *  of `unit`'s preferred-chain (clearing it when refuted) is the
   *  caller's responsibility — the worklist does it after firing. */
  fireRefute(unit: U, carrier: AssumptionChain): void;

  // --- rebuild ---

  scheduleRebuild(unit: U): void;
  flushPendingRebuilds(): readonly U[];
}
