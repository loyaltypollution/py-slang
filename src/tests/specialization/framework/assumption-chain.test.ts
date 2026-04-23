import {
  ROOT_CONTEXT,
  excludeAssumption,
  extendContext,
  findAssumption,
  hasAncestor,
  isRoot,
} from "../../../specialization/framework/assumption-chain";
import type { Narrowing } from "../../../specialization/framework/analysis";

function makeAnalysis<K, V>(_name: string): Narrowing<K, V> {
  return {
    eq: (a, b) => a === b,
    blockAnalysis: () => ({} as any),
    lift: () => undefined,
  };
}

describe("AssumptionChain", () => {
  it("ROOT_CONTEXT is root and has depth 0", () => {
    expect(isRoot(ROOT_CONTEXT)).toBe(true);
    expect(ROOT_CONTEXT.depth).toBe(0);
    expect(ROOT_CONTEXT.parent).toBeUndefined();
    expect(ROOT_CONTEXT.assumption).toBeUndefined();
  });

  it("extendContext produces a child with parent, assumption, depth+1", () => {
    const p = makeAnalysis<number, number>("p");
    const c1 = extendContext(ROOT_CONTEXT, p, 7, 42);

    expect(c1.parent).toBe(ROOT_CONTEXT);
    expect(c1.depth).toBe(1);
    expect(c1.assumption).toEqual({ narrowing: p, key: 7, value: 42 });
    expect(isRoot(c1)).toBe(false);
  });

  it("extendContext chains and tracks depth", () => {
    const p = makeAnalysis<number, number>("p");
    const c1 = extendContext(ROOT_CONTEXT, p, 1, 10);
    const c2 = extendContext(c1, p, 2, 20);
    const c3 = extendContext(c2, p, 3, 30);

    expect(c3.depth).toBe(3);
    expect(c3.parent).toBe(c2);
    expect(c2.parent).toBe(c1);
    expect(c1.parent).toBe(ROOT_CONTEXT);
  });

  it("findAssumption returns the deepest matching binding", () => {
    const p = makeAnalysis<number, number>("p");
    const q = makeAnalysis<number, number>("q");
    const c1 = extendContext(ROOT_CONTEXT, p, 7, 10);
    const c2 = extendContext(c1, p, 7, 20); // shadows c1's p@7
    const c3 = extendContext(c2, q, 7, 30);

    expect(findAssumption(c3, p, 7)).toBe(20);
    expect(findAssumption(c3, q, 7)).toBe(30);
    expect(findAssumption(c3, p, 8)).toBeUndefined();
  });

  it("findAssumption returns undefined at ROOT", () => {
    const p = makeAnalysis<number, number>("p");
    expect(findAssumption(ROOT_CONTEXT, p, 1)).toBeUndefined();
  });

  it("hasAncestor: ctx is its own ancestor; ROOT is ancestor of any child", () => {
    const p = makeAnalysis<number, number>("p");
    const c1 = extendContext(ROOT_CONTEXT, p, 1, 10);
    const c2 = extendContext(c1, p, 2, 20);

    expect(hasAncestor(c2, c2)).toBe(true);
    expect(hasAncestor(c2, c1)).toBe(true);
    expect(hasAncestor(c2, ROOT_CONTEXT)).toBe(true);
    expect(hasAncestor(c1, c2)).toBe(false);
  });

  it("siblings do not see each other's assumptions", () => {
    const p = makeAnalysis<number, number>("p");
    const left = extendContext(ROOT_CONTEXT, p, 1, 10);
    const right = extendContext(ROOT_CONTEXT, p, 1, 20);

    expect(findAssumption(left, p, 1)).toBe(10);
    expect(findAssumption(right, p, 1)).toBe(20);
    expect(hasAncestor(left, right)).toBe(false);
    expect(hasAncestor(right, left)).toBe(false);
  });

  it("extendContext freezes the returned node", () => {
    const p = makeAnalysis<number, number>("p");
    const c1 = extendContext(ROOT_CONTEXT, p, 1, 10);
    expect(Object.isFrozen(c1)).toBe(true);
    expect(Object.isFrozen(c1.assumption)).toBe(true);
  });

  it("excludeAssumption returns ctx unchanged when no link matches", () => {
    const p = makeAnalysis<number, number>("p");
    const c1 = extendContext(ROOT_CONTEXT, p, 1, 10);
    expect(excludeAssumption(c1, p, 99)).toBe(c1);
    expect(excludeAssumption(ROOT_CONTEXT, p, 1)).toBe(ROOT_CONTEXT);
  });

  it("excludeAssumption prunes matching links and rebuilds the chain above them", () => {
    const p = makeAnalysis<number, number>("p");
    const q = makeAnalysis<number, number>("q");
    const c1 = extendContext(ROOT_CONTEXT, p, 1, 10);
    const c2 = extendContext(c1, q, 2, 20);
    const c3 = extendContext(c2, p, 3, 30);

    const pruned = excludeAssumption(c3, q, 2);
    expect(pruned.depth).toBe(2);
    expect(findAssumption(pruned, q, 2)).toBeUndefined();
    expect(findAssumption(pruned, p, 1)).toBe(10);
    expect(findAssumption(pruned, p, 3)).toBe(30);
  });

  it("excludeAssumption removes every matching link, not just the first", () => {
    const p = makeAnalysis<number, number>("p");
    const c1 = extendContext(ROOT_CONTEXT, p, 7, 10);
    const c2 = extendContext(c1, p, 7, 20);

    const pruned = excludeAssumption(c2, p, 7);
    expect(pruned).toBe(ROOT_CONTEXT);
  });
});
