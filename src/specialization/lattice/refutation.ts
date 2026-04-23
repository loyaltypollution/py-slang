// Refutations as an upward-closed filter over AssumptionChains. When a
// runtime observation contradicts a stored assumption, every superset of
// the carrying chain becomes refuted. Stores only the minimal generators
// (an antichain) and answers membership via algebraic `leq`.

import type { AssumptionChain } from "./algebra";
import { leq } from "./algebra";

export class Refutations {
  private readonly generators: Set<AssumptionChain> = new Set();

  /** Record `s` as a refutation event. Empty is never refuted. Maintains
   *  `generators` as an antichain: skip when already covered, drop any
   *  existing generator superseded by the new smaller one. */
  add(s: AssumptionChain): void {
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
  contains(c: AssumptionChain): boolean {
    for (const r of this.generators) {
      if (leq(r, c)) return true;
    }
    return false;
  }

  /** Diagnostic: current generator count. */
  size(): number {
    return this.generators.size;
  }

  /** Drop every refutation event. For unit rebuild / test reset only —
   *  breaks the "once refuted, always refuted" invariant. */
  clear(): void {
    this.generators.clear();
  }
}
