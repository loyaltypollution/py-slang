// Refutation filter property suite.
//
// Every test states one filter law explicitly. The crucial property is
// "refutation is transitive across rebuild-path supersets" — the bug
// the old pointwise isRefuted + parent-walk hasAncestor missed.

import { extend, ROOT_CONTEXT, type NarrowingAxis } from "../../specialization/assumption/chain";
import { Refutations } from "../../specialization/assumption/refutation";

function mkN<K, V>(): NarrowingAxis<K, V> {
  return { eq: (a, b) => a === b };
}

describe("Refutations", () => {
  it("ROOT_CONTEXT filter: nothing refuted", () => {
    const r = new Refutations();
    const p = mkN<number, number>();
    const s = extend(ROOT_CONTEXT, p, 1, 10);
    expect(r.contains(ROOT_CONTEXT)).toBe(false);
    expect(r.contains(s)).toBe(false);
  });

  it("add(x): contains for x and every superset", () => {
    const r = new Refutations();
    const p = mkN<number, number>();
    const s = extend(ROOT_CONTEXT, p, 1, 10);
    const s2 = extend(s, p, 2, 20);
    const s3 = extend(s2, p, 3, 30);
    r.add(s);
    expect(r.contains(s)).toBe(true);
    expect(r.contains(s2)).toBe(true);
    expect(r.contains(s3)).toBe(true);
  });

  it("add(x): not refuted for sibling not containing x", () => {
    const r = new Refutations();
    const p = mkN<number, number>();
    const sA = extend(ROOT_CONTEXT, p, 1, 10);
    const sB = extend(ROOT_CONTEXT, p, 1, 20); // different value at same key
    r.add(sA);
    expect(r.contains(sA)).toBe(true);
    expect(r.contains(sB)).toBe(false); // sB does not contain sA's binding
  });

  it("refutation is algebraic-transitive for rebuild-path supersets", () => {
    // Build a superset via the rebuild path (new link sorts earlier than
    // parent's tip). Under the old parent-walk isRefuted this case was
    // a false negative.
    const r = new Refutations();
    const p = mkN<number, number>();
    const q = mkN<number, number>();
    const anchor = extend(ROOT_CONTEXT, p, 1, 10);
    const forward = extend(extend(ROOT_CONTEXT, p, 1, 10), q, 1, 20);
    const reverse = extend(extend(ROOT_CONTEXT, q, 1, 20), p, 1, 10);
    expect(forward).toBe(reverse); // interner reconvergence
    r.add(anchor);
    expect(r.contains(forward)).toBe(true);
    expect(r.contains(reverse)).toBe(true);
  });

  it("add is idempotent; size stays at the minimal-generator count", () => {
    const r = new Refutations();
    const p = mkN<number, number>();
    const s = extend(ROOT_CONTEXT, p, 1, 10);
    r.add(s);
    r.add(s);
    r.add(s);
    expect(r.size()).toBe(1);
  });

  it("add(ROOT_CONTEXT) is a no-op", () => {
    const r = new Refutations();
    r.add(ROOT_CONTEXT);
    expect(r.size()).toBe(0);
    expect(r.contains(ROOT_CONTEXT)).toBe(false);
  });

  it("late arrivals: extending a refuted set yields a refuted superset", () => {
    const r = new Refutations();
    const p = mkN<number, number>();
    const s = extend(ROOT_CONTEXT, p, 1, 10);
    r.add(s);
    // A later extend produces a superset of s, which is algebraically
    // refuted — without any interner hook, without any cascade.
    const later = extend(s, p, 2, 20);
    expect(r.contains(later)).toBe(true);
  });

  it("depth-3 regression: refute middle, contains holds for the deepest", () => {
    // A ⊑ B ⊑ C (canonical append chain). Refute B. C is a superset of B,
    // so contains(C) is true. A is not a superset of B, so contains(A)
    // is false.
    const r = new Refutations();
    const p = mkN<number, number>();
    const A = extend(ROOT_CONTEXT, p, 1, 10);
    const B = extend(A, p, 2, 20);
    const C = extend(B, p, 3, 30);
    r.add(B);
    expect(r.contains(A)).toBe(false);
    expect(r.contains(B)).toBe(true);
    expect(r.contains(C)).toBe(true);
  });

  it("clear() drops all generators", () => {
    const r = new Refutations();
    const p = mkN<number, number>();
    const s = extend(ROOT_CONTEXT, p, 1, 10);
    r.add(s);
    expect(r.contains(s)).toBe(true);
    r.clear();
    expect(r.contains(s)).toBe(false);
    expect(r.size()).toBe(0);
  });

  it("antichain minimization: superset-then-subset collapses to one generator", () => {
    // Insert a 2-binding set, then its 1-binding subset. The subset
    // supersedes the superset; size drops from 1 to 1 (not 2).
    const r = new Refutations();
    const p = mkN<number, number>();
    const q = mkN<number, number>();
    const superset = extend(extend(ROOT_CONTEXT, p, 1, 10), q, 2, 20);
    const subset = extend(ROOT_CONTEXT, p, 1, 10);
    r.add(superset);
    expect(r.size()).toBe(1);
    r.add(subset);
    expect(r.size()).toBe(1); // superset dropped
    // And the subset still covers the original superset.
    expect(r.contains(superset)).toBe(true);
    expect(r.contains(subset)).toBe(true);
  });

  it("antichain minimization: subset-then-superset is a no-op on the second add", () => {
    // Insert the subset first. Adding a superset is redundant — already
    // covered — and leaves the antichain at size 1.
    const r = new Refutations();
    const p = mkN<number, number>();
    const q = mkN<number, number>();
    const subset = extend(ROOT_CONTEXT, p, 1, 10);
    const superset = extend(subset, q, 2, 20);
    r.add(subset);
    expect(r.size()).toBe(1);
    r.add(superset);
    expect(r.size()).toBe(1);
  });
});
