// Function-domain contract — the lifecycle/scheduling/chain surface the
// worklist depends on.
//
// Function is the only swap function (see `publication.ts` for the OSR
// constraint that pins this). The worklist owns generic dispatch
// (analysis fan-out, transform sweep, refutation algebra) but routes
// every lifecycle / chain / refute / rebuild event through this
// interface so those concerns live with the program model rather than
// the driver.

import type { AssumptionChain } from "../assumption";
import type { FunctionExtent } from "../program/function-extent";
import type { Function } from "../program/function/function";
import type { FunctionLocator } from "../program/function/manager";

export type ExtentChangeListener = (
  function: Function,
  prev: FunctionExtent,
  next: FunctionExtent,
) => void;

export type ChainChangeListener = (
  function: Function,
  prev: AssumptionChain,
  next: AssumptionChain,
) => void;

export type RefuteListener = (function: Function, carrier: AssumptionChain) => void;

/** The lifecycle / speculation / scheduling contract for the Function
 *  domain.
 *
 *  All three lifecycle streams (`onExtentChange`, `onChainChange`,
 *  `onRefute`) are subscribe-once + replay-or-not-as-documented-by-each.
 *  The extent stream replays existing functions at subscribe time with
 *  `prev = EMPTY_NODESET`; the chain stream and refute stream do not
 *  replay (they only fire on subsequent events).
 *
 *  Rebuild is two-phase: `scheduleRebuild(function)` records intent;
 *  `flushPendingRebuilds()` materializes the change, fires the extent
 *  stream with non-empty (prev, next), and returns the functions that were
 *  actually rebuilt (in flush order). */
export interface FunctionDomain {
  /** The program-shape lookup surface concrete to this domain. */
  readonly locator: FunctionLocator;

  /** Live iteration over registered functions. The framework treats the
   *  result as a snapshot for the duration of one consumer call. */
  values(): Iterable<Function>;

  /** Snapshot of `function`'s current extent. Same shape as the `next`
   *  payload on the extent stream. */
  extentOf(function: Function): FunctionExtent;

  onExtentChange(cb: ExtentChangeListener): void;

  // --- chain (preferred future-dispatch) ---

  /** Read `function`'s preferred future-dispatch chain. Returns `ROOT_CONTEXT`
   *  when no preference is set. */
  chainFor(function: Function): AssumptionChain;
  /** Set the preferred future-dispatch chain for `function`. Does NOT fire
   *  `onChainChange` on its own — observation ingress fires the chain
   *  delta explicitly so the (prev, next) pair is correct. */
  setChainFor(function: Function, chain: AssumptionChain): void;
  /** Drop any preferred future-dispatch chain for `function`. */
  clearChainFor(function: Function): void;
  /** Subscribe to chain changes. */
  onChainChange(cb: ChainChangeListener): void;
  /** Manually fire the chain stream — used by observation ingress after
   *  it has reconciled `setChainFor`/`clearChainFor` with the new chain. */
  fireChainChange(function: Function, prev: AssumptionChain, next: AssumptionChain): void;

  // --- refute (orthogonal to chain change) ---

  /** Subscribe to refutation events. The carrier identity is preserved —
   *  consumers like memoization need it. */
  onRefute(cb: RefuteListener): void;
  /** Fire the refute stream for `function` against `carrier`. Reconciliation
   *  of `function`'s preferred-chain (clearing it when refuted) is the
   *  caller's responsibility — the worklist does it after firing. */
  fireRefute(function: Function, carrier: AssumptionChain): void;

  // --- rebuild ---

  scheduleRebuild(function: Function): void;
  flushPendingRebuilds(): readonly Function[];
}
