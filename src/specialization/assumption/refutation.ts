// Refutations: upward-closed filter over AssumptionChains. Stores minimal
// generators (an antichain); membership is `∃ r ∈ generators. leq(r, c)`.

import type { AssumptionChain } from "./algebra";
import { leq } from "./algebra";

export class Refutations {
  private readonly generators: Set<AssumptionChain> = new Set();

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

  contains(c: AssumptionChain): boolean {
    for (const r of this.generators) {
      if (leq(r, c)) return true;
    }
    return false;
  }

  size(): number {
    return this.generators.size;
  }

  clear(): void {
    this.generators.clear();
  }
}
