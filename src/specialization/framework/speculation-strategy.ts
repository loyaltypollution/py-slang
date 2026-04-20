// Speculation strategy: the policy layer between observations and AssumptionChain
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

import type { AssumptionChain } from "./context";
import type { Unit } from "./function-unit";
import type { RawKind } from "./raw-value";

export interface ObservationEvent {
  readonly unit: Unit;
  /** The observation's key in its source analysis's keyspace — nodeId
   *  for `runtimeWriteAnalysis`, functionId for `runtimeReturnAnalysis`, and
   *  whatever future narrowing dimensions define. Treat as an opaque
   *  identity for dedup/counting; do not assume it names an AST node. */
  readonly key: number;
  readonly observed: RawKind;
  /** The unit's current speculation context at the moment of observation.
   *  Strategies that care about chain depth or existing assumptions read
   *  it through here rather than reaching into Worklist state. */
  readonly parentContext: AssumptionChain;
}

export interface SpeculationStrategy {
  /** `true` → Worklist proceeds with mechanism (lift + extend + enqueue).
   *  `false` → no-op. A `false` return is expected to be common under
   *  threshold-based strategies: the observation is counted/queued but
   *  not yet acted on.
   *
   *  The strategy MUST NOT mutate `event` or any analysis store; it may
   *  mutate its own private state. */
  onObservation(event: ObservationEvent): boolean;

  /** Hook for strategies that track per-site history and need a clean
   *  slate when a unit retires. Optional — noop strategies can omit.  */
  onUnitRetired?(unit: Unit): void;
}

/** Reproduces the pre-strategy behavior: every observation triggers an
 *  extension. Equivalent to "no filter." Use for tests that want the old
 *  immediate-speculation semantics and for the Worklist default. */
export const immediateStrategy: SpeculationStrategy = {
  onObservation() {
    return true;
  },
};

/** Speculate only after the same `(key, discriminant)` has been observed
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
  const unitKeys = new WeakMap<Unit, Set<number>>();

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
    onObservation({ unit, key, observed }) {
      let perKey = counts.get(key);
      if (perKey === undefined) {
        perKey = new Map();
        counts.set(key, perKey);
      }
      const disc = discriminant(observed);
      const next = (perKey.get(disc) ?? 0) + 1;
      perKey.set(disc, next);

      let keys = unitKeys.get(unit);
      if (keys === undefined) {
        keys = new Set();
        unitKeys.set(unit, keys);
      }
      keys.add(key);

      return next >= threshold;
    },
    onUnitRetired(unit) {
      const keys = unitKeys.get(unit);
      if (keys === undefined) return;
      for (const key of keys) counts.delete(key);
      unitKeys.delete(unit);
    },
  };
}
