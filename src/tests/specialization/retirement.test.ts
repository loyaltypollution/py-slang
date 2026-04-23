// Retirement filter property suite.
//
// Every test states one filter law explicitly. The crucial property is
// "retirement is transitive across rebuild-path supersets" — the bug
// the old pointwise isRetired + parent-walk hasAncestor missed.

import type { Narrowing } from "../../specialization/framework/analysis";
import {
  empty,
  extend,
} from "../../specialization/framework/assumption-algebra";
import { Retirement } from "../../specialization/framework/retirement";

function mkN<K, V>(): Narrowing<K, V> {
  return {
    eq: (a, b) => a === b,
    blockAnalysis: () => ({} as any),
    lift: () => undefined,
  };
}

describe("Retirement", () => {
  it("empty filter: nothing retired", () => {
    const r = new Retirement();
    const p = mkN<number, number>();
    const s = extend(empty, p, 1, 10);
    expect(r.isRetired(empty)).toBe(false);
    expect(r.isRetired(s)).toBe(false);
  });

  it("retire(x): isRetired for x and every superset", () => {
    const r = new Retirement();
    const p = mkN<number, number>();
    const s = extend(empty, p, 1, 10);
    const s2 = extend(s, p, 2, 20);
    const s3 = extend(s2, p, 3, 30);
    r.retire(s);
    expect(r.isRetired(s)).toBe(true);
    expect(r.isRetired(s2)).toBe(true);
    expect(r.isRetired(s3)).toBe(true);
  });

  it("retire(x): not retired for sibling not containing x", () => {
    const r = new Retirement();
    const p = mkN<number, number>();
    const sA = extend(empty, p, 1, 10);
    const sB = extend(empty, p, 1, 20); // different value at same key
    r.retire(sA);
    expect(r.isRetired(sA)).toBe(true);
    expect(r.isRetired(sB)).toBe(false); // sB does not contain sA's binding
  });

  it("retirement is algebraic-transitive for rebuild-path supersets", () => {
    // Build a superset via the rebuild path (new link sorts earlier than
    // parent's tip). Under the old parent-walk isRetired this case was
    // a false negative.
    const r = new Retirement();
    const p = mkN<number, number>();
    const q = mkN<number, number>();
    const anchor = extend(empty, p, 1, 10);
    // Force a rebuild when extending: extend anchor with q@1, then extend
    // that with a smaller-sort link if ordinals land right. More robust:
    // build the same full set in two orders and check leq on both.
    const forward = extend(extend(empty, p, 1, 10), q, 1, 20);
    const reverse = extend(extend(empty, q, 1, 20), p, 1, 10);
    expect(forward).toBe(reverse); // interner reconvergence
    r.retire(anchor);
    expect(r.isRetired(forward)).toBe(true);
    expect(r.isRetired(reverse)).toBe(true);
  });

  it("retire is idempotent; size stays at the minimal-generator count", () => {
    const r = new Retirement();
    const p = mkN<number, number>();
    const s = extend(empty, p, 1, 10);
    r.retire(s);
    r.retire(s);
    r.retire(s);
    expect(r.size()).toBe(1);
  });

  it("retire(empty) is a no-op", () => {
    const r = new Retirement();
    r.retire(empty);
    expect(r.size()).toBe(0);
    expect(r.isRetired(empty)).toBe(false);
  });

  it("late arrivals: extending a retired set yields a retired superset", () => {
    const r = new Retirement();
    const p = mkN<number, number>();
    const s = extend(empty, p, 1, 10);
    r.retire(s);
    // A later extend produces a superset of s, which is algebraically
    // retired — without any interner hook, without any cascade.
    const later = extend(s, p, 2, 20);
    expect(r.isRetired(later)).toBe(true);
  });

  it("depth-3 regression: retire middle, isRetired holds for the deepest", () => {
    // A ⊑ B ⊑ C (canonical append chain). Retire B. C is a superset of B,
    // so isRetired(C) is true. A is not a superset of B, so isRetired(A)
    // is false.
    const r = new Retirement();
    const p = mkN<number, number>();
    const A = extend(empty, p, 1, 10);
    const B = extend(A, p, 2, 20);
    const C = extend(B, p, 3, 30);
    r.retire(B);
    expect(r.isRetired(A)).toBe(false);
    expect(r.isRetired(B)).toBe(true);
    expect(r.isRetired(C)).toBe(true);
  });

  it("clear() drops all generators", () => {
    const r = new Retirement();
    const p = mkN<number, number>();
    const s = extend(empty, p, 1, 10);
    r.retire(s);
    expect(r.isRetired(s)).toBe(true);
    r.clear();
    expect(r.isRetired(s)).toBe(false);
    expect(r.size()).toBe(0);
  });
});
