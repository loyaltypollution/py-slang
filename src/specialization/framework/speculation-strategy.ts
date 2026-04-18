// Speculation strategy: the policy layer between observations and Context
// extensions. Mechanism — lifting a RawKind to a lattice assumption, extending
// the context, enqueuing Kildall under it — is fixed and lives on Worklist.
// Policy — whether a given observation should trigger speculation at all —
// is swappable via SpeculationStrategy.
//
// The contract is explicitly narrow: `onObservation` returns `true` when
// mechanism should proceed, `false` to suppress. The strategy may hold state
// (e.g. a per-site counter) and must be pure-modulo-its-own-state.
// Mechanism code (Worklist) does not know what state strategies hold.
//
// This is the decoupling the brief's P4 argues for: "adding count-based
// speculation should touch the strategy module, not `constAnalysis`." If a
// future strategy needs a fact beyond (site, rawValue, parentContext) — e.g.
// a call-count, a cost estimate, an oracle hint — the interface widens here;
// analyses stay untouched.

import type { Context } from "./context";
import type { FunctionUnit } from "./function-unit";
import type { RawKind } from "./raw-value";

export interface ObservationEvent {
  readonly unit: FunctionUnit;
  readonly nodeId: number;
  readonly observed: RawKind;
  /** The unit's current speculation context at the moment of observation.
   *  Strategies that care about chain depth or existing assumptions read
   *  it through here rather than reaching into Worklist state. */
  readonly parentContext: Context;
}

export interface SpeculationStrategy {
  /** `true` → Worklist proceeds with mechanism (lift + extend + enqueue).
   *  `false` → no-op. A `false` return is expected to be common under
   *  threshold-based strategies: the observation is counted/queued but
   *  not yet acted on.
   *
   *  The strategy MUST NOT mutate `event` or the fact store; it may mutate
   *  its own private state. */
  onObservation(event: ObservationEvent): boolean;

  /** Hook for strategies that track per-site history and need a clean
   *  slate when a unit retires. Optional — noop strategies can omit.  */
  onUnitRetired?(unit: FunctionUnit): void;
}

/** Reproduces the pre-strategy behavior: every observation triggers an
 *  extension. Equivalent to "no filter." Use for tests that want the old
 *  immediate-speculation semantics and for the Worklist default. */
export const immediateStrategy: SpeculationStrategy = {
  onObservation() {
    return true;
  },
};

/** Speculate only after the same `(nodeId, discriminant)` has been observed
 *  `threshold` or more times. `discriminant` is the RawKind's `kind` plus
 *  any carried `value` — so `{kind:"number", value:1}` and
 *  `{kind:"number", value:2}` count separately, but repeated
 *  `{kind:"number", value:1}` converge on the counter.
 *
 *  Rationale: a single outlier shouldn't trigger a guarded specialization
 *  that immediately deopts. Under this strategy, the site must agree with
 *  itself `N` times before the translator extends the context. */
export function countBasedStrategy(threshold: number): SpeculationStrategy {
  if (threshold < 1 || !Number.isInteger(threshold)) {
    throw new Error(`[countBasedStrategy] threshold must be a positive integer, got ${threshold}`);
  }
  const counts = new Map<number, Map<string, number>>();
  const unitSites = new WeakMap<FunctionUnit, Set<number>>();

  const discriminant = (raw: RawKind): string => {
    switch (raw.kind) {
      case "number":
      case "bool":
      case "string":
        return `${raw.kind}:${String(raw.value)}`;
      default:
        return raw.kind;
    }
  };

  return {
    onObservation({ unit, nodeId, observed }) {
      let perSite = counts.get(nodeId);
      if (perSite === undefined) {
        perSite = new Map();
        counts.set(nodeId, perSite);
      }
      const disc = discriminant(observed);
      const next = (perSite.get(disc) ?? 0) + 1;
      perSite.set(disc, next);

      let sites = unitSites.get(unit);
      if (sites === undefined) {
        sites = new Set();
        unitSites.set(unit, sites);
      }
      sites.add(nodeId);

      return next >= threshold;
    },
    onUnitRetired(unit) {
      const sites = unitSites.get(unit);
      if (sites === undefined) return;
      for (const nodeId of sites) counts.delete(nodeId);
      unitSites.delete(unit);
    },
  };
}
