// Refutations as an upward-closed filter over Speculations.
//
// When a runtime observation contradicts a stored assumption, the binding
// that carried the conflicting value is refuted. Algebraically, every
// superset of a refuted speculation is also refuted — if {p@1 ↦ A} is
// invalid, so is {p@1 ↦ A, q@2 ↦ B}.
//
// The filter stores only the minimal generators and computes membership
// on the fly via algebraic `leq`. No cascade enumeration is needed:
// `contains(c)` returns true iff some generator is a subset of `c`, which
// covers trie-descendant supersets *and* rebuild-path supersets (which a
// parent-walk ancestry check would miss).
//
// Refutation has no side effects on body storage; the refutation-aware
// `visibleBody` walker in assumption-bodies.ts consults the predicate at
// each ancestor step and skips refuted nodes. Stale forked bodies at
// refuted supersets are reclaimed when the unit releases.

import type { Speculation } from "./assumption-algebra";
import { leq } from "./assumption-algebra";

export class Refutations {
  private readonly generators: Set<Speculation> = new Set();

  /** Record `s` as a refutation event. Empty is never refuted.
   *  Maintains `generators` as an antichain: on add, drop any existing
   *  generator `r'` with `leq(s, r')` (superseded by the new smaller
   *  generator) and skip the add if some existing `r` has `leq(r, s)`
   *  (already covered). Bounds `contains` cost to the size of the
   *  antichain rather than the cumulative history of refutations. */
  add(s: Speculation): void {
    if (s.parent === undefined) return;
    for (const r of this.generators) {
      if (leq(r, s)) return;
    }
    for (const r of this.generators) {
      if (leq(s, r)) this.generators.delete(r);
    }
    this.generators.add(s);
  }

  /** `c` is refuted iff some stored generator `r` satisfies `leq(r, c)`. */
  contains(c: Speculation): boolean {
    if (this.generators.size === 0) return false;
    for (const r of this.generators) {
      if (leq(r, c)) return true;
    }
    return false;
  }

  /** Diagnostic: current generator count. */
  size(): number {
    return this.generators.size;
  }

  /** Drop every refutation event. Intended for unit rebuild / test reset;
   *  breaks the "once refuted, always refuted" monotonicity invariant, so
   *  production code should not call this. */
  clear(): void {
    this.generators.clear();
  }
}
