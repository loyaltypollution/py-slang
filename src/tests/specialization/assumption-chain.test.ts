import type { NarrowingAxis } from "../../specialization/assumption/chain";
import {
  ROOT_CONTEXT,
  at,
  extend,
  isRoot,
  leq,
  without,
} from "../../specialization/assumption/chain";

export function makeAnalysis<K, V>(eq: (a: V, b: V) => boolean = Object.is): NarrowingAxis<K, V> {
  return { eq };
}

describe("AssumptionChain", () => {
  it("ROOT_CONTEXT is root and has depth 0", () => {
    expect(isRoot(ROOT_CONTEXT)).toBe(true);
    expect(ROOT_CONTEXT.depth).toBe(0);
  });

  it("extend produces a child with parent, assumption, depth+1", () => {
    const p = makeAnalysis<number, number>();
    const c1 = extend(ROOT_CONTEXT, p, 7, 42);

    expect(c1.parent).toBe(ROOT_CONTEXT);
    expect(c1.depth).toBe(1);
    expect(c1.assumption).toEqual({ narrowing: p, key: 7, value: 42 });
    expect(isRoot(c1)).toBe(false);
  });

  it("extend chains and tracks depth", () => {
    const p = makeAnalysis<number, number>();
    const c1 = extend(ROOT_CONTEXT, p, 1, 10);
    const c2 = extend(c1, p, 2, 20);
    const c3 = extend(c2, p, 3, 30);

    expect(c3.depth).toBe(3);
    expect(c3.parent).toBe(c2);
    expect(c2.parent).toBe(c1);
    expect(c1.parent).toBe(ROOT_CONTEXT);
  });

  it("at returns the bound value", () => {
    const p = makeAnalysis<number, number>();
    const q = makeAnalysis<number, number>();
    // Strict extend: replacement goes through without() first.
    const c1 = extend(ROOT_CONTEXT, p, 7, 10);
    const c2 = extend(without(c1, p, 7), p, 7, 20);
    const c3 = extend(c2, q, 7, 30);

    expect(at(c3, p, 7)).toBe(20);
    expect(at(c3, q, 7)).toBe(30);
    expect(at(c3, p, 8)).toBeUndefined();
  });

  it("at returns undefined at ROOT", () => {
    const p = makeAnalysis<number, number>();
    expect(at(ROOT_CONTEXT, p, 1)).toBeUndefined();
  });

  it("leq: empty ⊑ s; s ⊑ s; s ⊑ extend(s, a)", () => {
    const p = makeAnalysis<number, number>();
    const c1 = extend(ROOT_CONTEXT, p, 1, 10);
    const c2 = extend(c1, p, 2, 20);

    expect(leq(c2, c2)).toBe(true);
    expect(leq(c1, c2)).toBe(true);
    expect(leq(ROOT_CONTEXT, c2)).toBe(true);
    expect(leq(c2, c1)).toBe(false);
  });

  it("siblings do not see each other's assumptions", () => {
    const p = makeAnalysis<number, number>();
    const left = extend(ROOT_CONTEXT, p, 1, 10);
    const right = extend(ROOT_CONTEXT, p, 1, 20);

    expect(at(left, p, 1)).toBe(10);
    expect(at(right, p, 1)).toBe(20);
    expect(leq(right, left)).toBe(false);
    expect(leq(left, right)).toBe(false);
  });

  it("extend freezes the returned node", () => {
    const p = makeAnalysis<number, number>();
    const c1 = extend(ROOT_CONTEXT, p, 1, 10);
    expect(Object.isFrozen(c1)).toBe(true);
    expect(Object.isFrozen(c1.assumption)).toBe(true);
  });

  it("without returns ctx unchanged when no link matches", () => {
    const p = makeAnalysis<number, number>();
    const c1 = extend(ROOT_CONTEXT, p, 1, 10);
    expect(without(c1, p, 99)).toBe(c1);
    expect(without(ROOT_CONTEXT, p, 1)).toBe(ROOT_CONTEXT);
  });

  it("without prunes matching links and rebuilds the chain above them", () => {
    const p = makeAnalysis<number, number>();
    const q = makeAnalysis<number, number>();
    const c1 = extend(ROOT_CONTEXT, p, 1, 10);
    const c2 = extend(c1, q, 2, 20);
    const c3 = extend(c2, p, 3, 30);

    const pruned = without(c3, q, 2);
    expect(pruned.depth).toBe(2);
    expect(at(pruned, q, 2)).toBeUndefined();
    expect(at(pruned, p, 1)).toBe(10);
    expect(at(pruned, p, 3)).toBe(30);
  });

  it("without then extend at same axis replaces the binding", () => {
    const p = makeAnalysis<number, number>();
    const c1 = extend(ROOT_CONTEXT, p, 7, 10);
    const c2 = extend(without(c1, p, 7), p, 7, 20);
    expect(at(c2, p, 7)).toBe(20);
    expect(c2.depth).toBe(1);
  });
});
