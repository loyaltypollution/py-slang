import type { View } from "./view";

/** Per-kind program-wide manager. Owns the view registry, mint/rebuild
 *  lifecycle, and lifecycle subscriptions. One concrete `ViewManager<V>`
 *  per view kind. Today only `Function` has one (`FunctionManager`); the
 *  shell exists so a hypothetical `LoopManager` or `RegionManager` reuses
 *  the lifecycle vocabulary without re-inventing it.
 *
 *  Per-kind lookups (e.g. `functionById`, `blockContaining`) are NOT part
 *  of this generic shell — those are kind-specific and live on the
 *  concrete manager / its `Locator` companion. */
export interface ViewManager<V extends View> {
  /** Iterate all currently-registered views in registration order. */
  values(): Iterable<V>;
  /** Subscribe to mint events. Implementations should fire immediately
   *  against every existing view so late subscribers see the initial
   *  burst. */
  onMint(cb: (view: V) => void): void;
  /** Subscribe to rebuild events. Fires when a view's structural backing
   *  is replaced (e.g. CFG rewire). Subscribers commonly pair this with
   *  store eviction for view-keyed cells. */
  onRebuild(cb: (view: V) => void): void;
}
