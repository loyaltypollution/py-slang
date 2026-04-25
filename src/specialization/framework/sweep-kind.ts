import type { AssumptionChain } from "../assumption";
import type { View } from "../program/views/view";

/** Worklist's view of one transform-sweep granularity — the unit at which
 *  transform dirty sets are keyed and at which `TransformRule.sweep(view, ...)`
 *  runs.
 *
 *  Per root view kind, a `SweepKind<V>` answers four operational questions:
 *    - mint  → when does a fresh `V` enter the dirty set?
 *    - rebuild → when does an existing `V` re-enter the dirty set?
 *    - chainFor(view) → what speculation chain does `sweep` run under?
 *    - scheduleRebuild(view) → after a transform fires, what gets rewired?
 *
 *  Today there is one implementation: `FunctionSweepKind`, served by
 *  `FunctionManager`. A future Loop view that wants its own transform-sweep
 *  granularity (independent of full-function rebuild) ships its own
 *  `SweepKind<Loop>` — defining Loop mint/rebuild wiring, the chain a Loop
 *  sweeps under (typically inherited from its containing function in
 *  Phase 10's Case A; independently owned in Case B), and how to schedule a
 *  Loop-scoped rebuild.
 *
 *  Scope: SweepKind exists for *transform* sweep polymorphism only. Analysis
 *  subscriptions (`subscribe` / `subscribeOnAdvance` / `onMint` /
 *  `onRebuildDirty` / `onSpecRev`) keep their analysis-key dirty model —
 *  those are keyed by `K extends NodeSet`, not by view kind, and do not
 *  pass through this interface. */
export interface SweepKind<V extends View> {
  /** Subscribe to mint events. Implementations should fire immediately
   *  against every existing instance so late subscribers see the burst. */
  onMint(cb: (view: V) => void): void;
  /** Subscribe to rebuild events. Fires when a view's structural backing is
   *  replaced; transform dirty sets re-add the view. */
  onRebuild(cb: (view: V) => void): void;
  /** Speculation chain to sweep `view` under. */
  chainFor(view: V): AssumptionChain;
  /** Schedule a structural rebuild for `view` after a transform fires. */
  scheduleRebuild(view: V): void;
}
