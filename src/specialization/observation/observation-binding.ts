import type { NarrowingId } from "../assumption";
import type { UnitResolver } from "../framework/analysis";
import type { ObservationChannel } from "./observation-channel";

export interface ObservationBinding<K = any, V = unknown, O = unknown> {
  readonly narrowing: NarrowingId<K, V>;
  readonly source: ObservationChannel<K, O>;
  /** `undefined` = observation doesn't map (skip without refuting). */
  lift(observed: O): V | undefined;
  /** Defaults to `unitOfNodeId` at the worklist when omitted. */
  resolveUnit?: UnitResolver<K>;
}
