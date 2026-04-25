import type { AssumptionChain } from "../assumption";
import type { View } from "../program/views/view";

/** Per-root-view-kind transform-sweep granularity: dirty-set keying,
 *  mint/rebuild wiring, sweep-time chain selection, and post-fire rebuild
 *  scheduling. Distinct from analysis-key dirtying (`subscribe` /
 *  `subscribeOnAdvance` / `onMint` / `onRebuildDirty` / `onSpecRev`),
 *  which is keyed by `K extends NodeSet`, not by view kind. */
export interface SweepKind<V extends View> {
  /** Must fire immediately against every existing instance so late
   *  subscribers see the mint burst. */
  onMint(cb: (view: V) => void): void;
  onRebuild(cb: (view: V) => void): void;
  chainFor(view: V): AssumptionChain;
  scheduleRebuild(view: V): void;
}
