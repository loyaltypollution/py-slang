import {
  ROOT_CONTEXT,
  excludeAssumption,
  extendContext,
  findAssumption,
  hasAncestor,
  isRoot,
} from "../../../specialization/framework/context";
import type { Analysis, AnalysisCtx, Lattice } from "../../../specialization/framework/analysis";

const trivialLattice: Lattice<number> = {
  bottom: 0,
  leq: (a, b) => a <= b,
  join: (a, b) => Math.max(a, b),
};

function makeAnalysis<K, V>(name: string, lattice: Lattice<V>): Analysis<K, V> {
  return {
    id: Symbol(name),
    debugName: name,
    lattice,
    edges: [],
    tier: "analysis",
    transfer: (_: unknown, __: AnalysisCtx, ___: K) => undefined,
  };
}

describe("Context", () => {
  it("ROOT_CONTEXT is root and has depth 0", () => {
    expect(isRoot(ROOT_CONTEXT)).toBe(true);
    expect(ROOT_CONTEXT.depth).toBe(0);
    expect(ROOT_CONTEXT.parent).toBeUndefined();
    expect(ROOT_CONTEXT.assumption).toBeUndefined();
  });

  it("extendContext produces a child with parent, assumption, depth+1", () => {
    const p = makeAnalysis<number, number>("p", trivialLattice);
    const c1 = extendContext(ROOT_CONTEXT, p, 7, 42);

    expect(c1.parent).toBe(ROOT_CONTEXT);
    expect(c1.depth).toBe(1);
    expect(c1.assumption).toEqual({ analysis: p, key: 7, value: 42 });
    expect(isRoot(c1)).toBe(false);
  });

  it("extendContext chains and tracks depth", () => {
    const p = makeAnalysis<number, number>("p", trivialLattice);
    const c1 = extendContext(ROOT_CONTEXT, p, 1, 10);
    const c2 = extendContext(c1, p, 2, 20);
    const c3 = extendContext(c2, p, 3, 30);

    expect(c3.depth).toBe(3);
    expect(c3.parent).toBe(c2);
    expect(c2.parent).toBe(c1);
    expect(c1.parent).toBe(ROOT_CONTEXT);
  });

  it("findAssumption returns the deepest matching binding", () => {
    const p = makeAnalysis<number, number>("p", trivialLattice);
    const q = makeAnalysis<number, number>("q", trivialLattice);
    const c1 = extendContext(ROOT_CONTEXT, p, 7, 10);
    const c2 = extendContext(c1, p, 7, 20); // shadows c1's p@7
    const c3 = extendContext(c2, q, 7, 30);

    expect(findAssumption(c3, p, 7)).toBe(20);
    expect(findAssumption(c3, q, 7)).toBe(30);
    expect(findAssumption(c3, p, 8)).toBeUndefined();
  });

  it("findAssumption returns undefined at ROOT", () => {
    const p = makeAnalysis<number, number>("p", trivialLattice);
    expect(findAssumption(ROOT_CONTEXT, p, 1)).toBeUndefined();
  });

  it("hasAncestor: ctx is its own ancestor; ROOT is ancestor of any child", () => {
    const p = makeAnalysis<number, number>("p", trivialLattice);
    const c1 = extendContext(ROOT_CONTEXT, p, 1, 10);
    const c2 = extendContext(c1, p, 2, 20);

    expect(hasAncestor(c2, c2)).toBe(true);
    expect(hasAncestor(c2, c1)).toBe(true);
    expect(hasAncestor(c2, ROOT_CONTEXT)).toBe(true);
    expect(hasAncestor(c1, c2)).toBe(false);
  });

  it("siblings do not see each other's assumptions", () => {
    const p = makeAnalysis<number, number>("p", trivialLattice);
    const left = extendContext(ROOT_CONTEXT, p, 1, 10);
    const right = extendContext(ROOT_CONTEXT, p, 1, 20);

    expect(findAssumption(left, p, 1)).toBe(10);
    expect(findAssumption(right, p, 1)).toBe(20);
    expect(hasAncestor(left, right)).toBe(false);
    expect(hasAncestor(right, left)).toBe(false);
  });

  it("extendContext freezes the returned node", () => {
    const p = makeAnalysis<number, number>("p", trivialLattice);
    const c1 = extendContext(ROOT_CONTEXT, p, 1, 10);
    expect(Object.isFrozen(c1)).toBe(true);
    expect(Object.isFrozen(c1.assumption)).toBe(true);
  });

  it("excludeAssumption returns ctx unchanged when no link matches", () => {
    const p = makeAnalysis<number, number>("p", trivialLattice);
    const c1 = extendContext(ROOT_CONTEXT, p, 1, 10);
    expect(excludeAssumption(c1, p, 99)).toBe(c1);
    expect(excludeAssumption(ROOT_CONTEXT, p, 1)).toBe(ROOT_CONTEXT);
  });

  it("excludeAssumption prunes matching links and rebuilds the chain above them", () => {
    const p = makeAnalysis<number, number>("p", trivialLattice);
    const q = makeAnalysis<number, number>("q", trivialLattice);
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
    const p = makeAnalysis<number, number>("p", trivialLattice);
    const c1 = extendContext(ROOT_CONTEXT, p, 7, 10);
    const c2 = extendContext(c1, p, 7, 20);

    const pruned = excludeAssumption(c2, p, 7);
    expect(pruned).toBe(ROOT_CONTEXT);
  });
});
