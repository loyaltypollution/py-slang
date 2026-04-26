import type { NarrowingId } from "../assumption";
import type { ObservationSource } from "./observation-channel";

export interface ObservationBinding<U, L, K = any, V = unknown, O = unknown> {
  readonly narrowing: NarrowingId<K, V>;
  readonly source: ObservationSource<K, O>;
  /** `undefined` = observation doesn't map (skip without refuting). */
  lift(observed: O): V | undefined;
  /** Defaults at the worklist to `(loc, key) => loc.unitContainingNode(key)`
   *  when omitted — i.e. the observation key is treated as a NodeId. */
  resolveUnit?: (locator: L, key: K) => U | undefined;
}
