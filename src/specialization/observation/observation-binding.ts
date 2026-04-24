// Observation glue for a narrowing dimension.
//
// Pairs a chain-axis (`narrowing`) with the runtime channel that drives it
// (`source`), the lift function turning a `RawKind` into the narrowing's
// value type, and an optional unit resolver. Kept separate from `Narrowing`
// so the framework can stay observation-agnostic — purely-static narrowings
// declare a narrowing alone with no binding; observation-driven narrowings
// pair a narrowing with a binding registered at composition time.

import type { NarrowingId } from "../assumption";
import type { UnitResolver } from "../framework/analysis";
import type { ObservationChannel } from "./observation-channel";
import type { RawKind } from "./raw-value";

export interface ObservationBinding<K = any, V = unknown> {
  readonly narrowing: NarrowingId<K, V>;
  readonly source: ObservationChannel<K, RawKind>;
  /** Map an observation onto the narrowing's value space. `undefined` =
   *  this observation kind doesn't map (skip without refuting). */
  lift(observed: RawKind): V | undefined;
  /** Resolve the unit owning a given key. Defaults to `unitOfNodeId` at
   *  the worklist when omitted. */
  resolveUnit?: UnitResolver<K>;
}
