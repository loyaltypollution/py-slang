import type { NarrowingId } from "../assumption";
import type { Function } from "../program/function";
import type { FunctionLocator } from "../program/function-locator";
import type { ObservationChannel } from "./observation-channel";

export interface ObservationBinding<K = any, V = unknown, O = unknown> {
  readonly narrowing: NarrowingId<K, V>;
  readonly source: ObservationChannel<K, O>;
  /** `undefined` = observation doesn't map (skip without refuting). */
  lift(observed: O): V | undefined;
  /** Defaults at the worklist to `(loc, key) => loc.unitContainingNode(key)`
   *  when omitted — i.e. the channel key is treated as a NodeId. */
  resolveUnit?: (locator: FunctionLocator, key: K) => Function | undefined;
}
