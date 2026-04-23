// Property suite for the assumption-algebra module. Each test states one
// algebraic law explicitly; together they pin down the semilattice shape
// the rest of the framework reads as load-bearing invariants.

import type { Narrowing } from "../../specialization/framework/analysis";
import {
  at,
  bindings,
  carrier,
  empty,
  extend,
  leq,
  without,
} from "../../specialization/framework/assumption-algebra";

function mkN<K, V>(eq: (a: V, b: V) => boolean = (a, b) => a === b): Narrowing<K, V> {
  return {
    eq,
    blockAnalysis: () => ({} as any),
    lift: () => undefined,
  };
}

describe("assumption-algebra", () => {
  it("leq(empty, s) for every s", () => {
    const p = mkN<number, number>();
    const s0 = empty;
    const s1 = extend(empty, p, 1, 10);
    const s2 = extend(s1, p, 2, 20);
    expect(leq(empty, s0)).toBe(true);
    expect(leq(empty, s1)).toBe(true);
    expect(leq(empty, s2)).toBe(true);
  });

  it("leq(s, extend(s, a)) for any compatible a", () => {
    const p = mkN<number, number>();
    const q = mkN<number, number>();
    const s = extend(empty, p, 1, 10);
    const s2 = extend(s, q, 2, 20);
    expect(leq(s, s2)).toBe(true);
    expect(leq(s, s)).toBe(true);
  });

  it("leq is algebraic, not parent-path: rebuild-built supersets are detected", () => {
    // Build a chain in non-canonical order so the trie takes the rebuild
    // path. Without the content-addressed bindings, the superset's
    // parent-walk does not pass through the subset; this test pins the
    // algebraic semantics.
    const p = mkN<number, number>();
    const q = mkN<number, number>();
    const r = mkN<number, number>();
    const sp = extend(empty, p, 1, 10);
    // Extend with q@1 and r@1 in whichever order the ordinal assignment
    // picked up. Both extensions should still preserve leq(sp, full).
    const full = extend(extend(sp, q, 1, 20), r, 1, 30);
    // Also build the same full set via a deliberately-reverse-ordered
    // sequence to force rebuilds.
    const fullAlt = extend(extend(extend(empty, r, 1, 30), q, 1, 20), p, 1, 10);
    expect(fullAlt).toBe(full); // reconvergence
    expect(leq(sp, full)).toBe(true);
    expect(leq(sp, fullAlt)).toBe(true);
    expect(leq(full, sp)).toBe(false);
  });

  it("extend is canonical: same (s, a) yields ===-equal results", () => {
    const p = mkN<number, number>();
    const a = extend(empty, p, 1, 10);
    const b = extend(empty, p, 1, 10);
    expect(a).toBe(b);
  });

  it("extend is idempotent: re-extending with the bound value returns the same set", () => {
    const p = mkN<number, number>();
    const s = extend(empty, p, 1, 10);
    expect(extend(s, p, 1, 10)).toBe(s);
  });

  it("without then extend at the same axis with the bound value is identity", () => {
    const p = mkN<number, number>();
    const s = extend(empty, p, 1, 10);
    const round = extend(without(s, p, 1), p, 1, 10);
    expect(round).toBe(s);
  });

  it("extend throws on conflicting binding at the same (narrowing, key)", () => {
    const p = mkN<number, number>();
    const s = extend(empty, p, 1, 10);
    expect(() => extend(s, p, 1, 20)).toThrow();
    const replaced = extend(without(s, p, 1), p, 1, 20);
    expect(at(replaced, p, 1)).toBe(20);
  });

  it("extend throws when the conflict is mid-chain (rebuild path)", () => {
    const p = mkN<number, number>();
    const q = mkN<number, number>();
    const sq = extend(empty, q, 1, 100);
    const sqp = extend(sq, p, 1, 10);
    expect(() => extend(sqp, q, 1, 200)).toThrow();
  });

  it("at is O(1) map lookup; undefined for missing bindings", () => {
    const p = mkN<number, number>();
    const q = mkN<number, number>();
    const s = extend(extend(empty, p, 1, 10), q, 2, 20);
    expect(at(s, p, 1)).toBe(10);
    expect(at(s, q, 2)).toBe(20);
    expect(at(s, p, 99)).toBeUndefined();
    expect(at(s, q, 99)).toBeUndefined();
    expect(at(empty, p, 1)).toBeUndefined();
  });

  it("carrier returns the canonical parent-path node introducing a binding", () => {
    const p = mkN<number, number>();
    const s = extend(extend(empty, p, 1, 10), p, 2, 20);
    const c = carrier(s, p, 2);
    expect(c).not.toBeUndefined();
    expect(c!.assumption?.value).toBe(20);
    expect(carrier(s, p, 99)).toBeUndefined();
  });

  it("without identity-returns when no binding matched", () => {
    const p = mkN<number, number>();
    const s = extend(empty, p, 1, 10);
    expect(without(s, p, 99)).toBe(s);
    expect(without(empty, p, 1)).toBe(empty);
  });

  it("bindings() yields every (narrowing, key, value) in the set", () => {
    const p = mkN<number, number>();
    const q = mkN<number, number>();
    const s = extend(extend(empty, p, 1, 10), q, 2, 20);
    const collected = Array.from(bindings(s))
      .map(a => [a.narrowing === p ? "p" : "q", a.key, a.value])
      .sort();
    expect(collected).toEqual([
      ["p", 1, 10],
      ["q", 2, 20],
    ]);
    expect(Array.from(bindings(empty))).toEqual([]);
  });

  it("leq argument order is anc-first", () => {
    const p = mkN<number, number>();
    const a = extend(empty, p, 1, 10);
    const b = extend(a, p, 2, 20);
    expect(leq(a, b)).toBe(true);
    expect(leq(b, a)).toBe(false);
  });

  // Partial-order axioms for ⊑. Pinned explicitly so refactors that touch
  // leq can't silently break the semilattice contract.

  it("leq is reflexive: leq(s, s) for every s", () => {
    const p = mkN<number, number>();
    const q = mkN<number, number>();
    const s0 = empty;
    const s1 = extend(empty, p, 1, 10);
    const s2 = extend(extend(empty, p, 1, 10), q, 2, 20);
    expect(leq(s0, s0)).toBe(true);
    expect(leq(s1, s1)).toBe(true);
    expect(leq(s2, s2)).toBe(true);
  });

  it("leq is antisymmetric: leq(a,b) ∧ leq(b,a) ⇒ a === b (via interner canonicity)", () => {
    const p = mkN<number, number>();
    const q = mkN<number, number>();
    // Two build orders for the same binding set reconverge; mutual leq
    // witnesses antisymmetry collapsed onto reference equality.
    const forward = extend(extend(empty, p, 1, 10), q, 2, 20);
    const reverse = extend(extend(empty, q, 2, 20), p, 1, 10);
    expect(leq(forward, reverse)).toBe(true);
    expect(leq(reverse, forward)).toBe(true);
    expect(forward).toBe(reverse);
  });

  it("leq is transitive: leq(a,b) ∧ leq(b,c) ⇒ leq(a,c)", () => {
    const p = mkN<number, number>();
    const q = mkN<number, number>();
    const r = mkN<number, number>();
    const a = extend(empty, p, 1, 10);
    const b = extend(a, q, 2, 20);
    const c = extend(b, r, 3, 30);
    expect(leq(a, b)).toBe(true);
    expect(leq(b, c)).toBe(true);
    expect(leq(a, c)).toBe(true);
  });
});
