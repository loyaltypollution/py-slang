import type { AssumptionChain } from "../assumption";
import type { NodeSet } from "../program/node-set";

/** Per-root-view-kind transform-sweep granularity: dirty-set keying,
 *  mint/rebuild wiring, sweep-time chain selection, and post-fire rebuild
 *  scheduling. Slated for deletion in Phase 18 — one consumer
 *  (`FunctionManager`), no second in sight. */
export interface SweepKind<V extends NodeSet> {
  /** Must fire immediately against every existing instance so late
   *  subscribers see the mint burst. */
  onMint(cb: (view: V) => void): void;
  onRebuild(cb: (view: V) => void): void;
  chainFor(view: V): AssumptionChain;
  scheduleRebuild(view: V): void;
}
