// Retirement as an upward-closed filter over AssumptionSets.
//
// When a runtime observation contradicts a stored assumption, the
// assumption-set that carried the conflicting binding is retired.
// Algebraically, every superset of a retired set is also retired —
// if {p@1 ↦ A} is invalid, so is {p@1 ↦ A, q@2 ↦ B}.
//
// This module stores only the minimal generators and computes
// membership on the fly via algebraic `leq`. No cascade enumeration is
// needed: `isRetired(c)` returns true iff some generator is a subset of
// `c`, which covers trie-descendant supersets *and* rebuild-path
// supersets (which a parent-walk ancestry check would miss).
//
// Retirement has no side effects on body storage; the retirement-aware
// `visibleBody` walker in assumption-bodies.ts consults `isRetired` at
// each ancestor step and skips retired nodes. Stale forked bodies at
// retired supersets are reclaimed when the unit releases.

import type { AssumptionSet } from "./assumption-algebra";
import { leq } from "./assumption-algebra";

export class Retirement {
  private readonly generators: Set<AssumptionSet> = new Set();

  /** Record `s` as a retirement event. Empty is never retired. Idempotent. */
  retire(s: AssumptionSet): void {
    if (s.parent === undefined) return;
    this.generators.add(s);
  }

  /** `c` is retired iff some stored generator `r` satisfies `leq(r, c)`. */
  isRetired(c: AssumptionSet): boolean {
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

  /** Drop every retirement event. Intended for unit rebuild / test reset. */
  clear(): void {
    this.generators.clear();
  }
}
