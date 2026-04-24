// Pairs a chain-axis (`narrowing`) with the runtime channel that drives
// it (`source`) and a lift from `RawKind` into the narrowing's value type.
// Static-only narrowings declare a narrowing without a binding.

import type { NarrowingId } from "../assumption";
import type { UnitResolver } from "../framework/analysis";
import type { ObservationChannel } from "./observation-channel";
import type { RawKind } from "./raw-value";

export interface ObservationBinding<K = any, V = unknown> {
  readonly narrowing: NarrowingId<K, V>;
  readonly source: ObservationChannel<K, RawKind>;
  /** `undefined` = this observation kind doesn't map (skip without refuting). */
  lift(observed: RawKind): V | undefined;
  /** Defaults to `unitOfNodeId` at the worklist when omitted. */
  resolveUnit?: UnitResolver<K>;
}
