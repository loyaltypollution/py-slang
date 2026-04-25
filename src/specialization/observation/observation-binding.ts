// Pairs a chain-axis (`narrowing`) with the runtime channel that drives
// it (`source`) and a lift from the channel's observation type `O` into
// the narrowing's value type `V`. Static-only narrowings declare a
// narrowing without a binding.

import type { NarrowingId } from "../assumption";
import type { UnitResolver } from "../framework/analysis";
import type { ObservationChannel } from "./observation-channel";

export interface ObservationBinding<K = any, V = unknown, O = unknown> {
  readonly narrowing: NarrowingId<K, V>;
  readonly source: ObservationChannel<K, O>;
  /** `undefined` = this observation value doesn't map (skip without refuting). */
  lift(observed: O): V | undefined;
  /** Defaults to `unitOfNodeId` at the worklist when omitted. */
  resolveUnit?: UnitResolver<K>;
}
