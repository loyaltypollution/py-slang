// Canonicalization invariants of the AssumptionChain interner (now folded
// into chain.ts). The interner state is module-level — tests that previously
// asserted instance isolation no longer apply; the algorithm tests below
// remain because they pin down the dedup, order-independence, and
// reconvergence properties downstream consumers (AnalysisStore,
// forked-body cache) ride on.

import type { JoinSemiLattice } from "../../specialization/framework/analysis";
import { AnalysisStore } from "../../specialization/framework/analysis-store";
import {
  at,
  debugChainNodeCount,
  extend,
  ROOT_CONTEXT,
  without,
} from "../../specialization/assumption/chain";
import {
  box,
  boxedEq,
  makeNarrowing as makeAnalysis,
  type Boxed,
} from "./harness/lattice-doubles";

describe("AssumptionChain canonicalization", () => {
  it("root is stable: extending from ROOT_CONTEXT never mints a new root", () => {
    const p = makeAnalysis<number, number>((a, b) => a === b);
    const c1 = extend(ROOT_CONTEXT, p, 1, 10);
    expect(c1.parent).toBe(ROOT_CONTEXT);
  });

  it("same observation is idempotent: repeated extend returns ===", () => {
    const p = makeAnalysis<number, number>((a, b) => a === b);
    const a = extend(ROOT_CONTEXT, p, 1, 10);
    const b = extend(ROOT_CONTEXT, p, 1, 10);
    expect(a).toBe(b);
  });

  it("structurally-equal values dedup via narrowing.eq", () => {
    const h = makeAnalysis<number, Boxed>(boxedEq);
    const a = extend(ROOT_CONTEXT, h, 1, box(42));
    const b = extend(ROOT_CONTEXT, h, 1, box(42));
    expect(a).toBe(b);
  });

  it("order-independence: same assumption set → same canonical chain", () => {
    const p = makeAnalysis<number, number>((a, b) => a === b);
    const q = makeAnalysis<number, number>((a, b) => a === b);
    const forward = extend(extend(ROOT_CONTEXT, p, 1, 10), q, 2, 20);
    const backward = extend(extend(ROOT_CONTEXT, q, 2, 20), p, 1, 10);
    expect(forward).toBe(backward);
  });

  it("without returns pre-built sibling (the chain→tree payoff)", () => {
    const p = makeAnalysis<number, number>((a, b) => a === b);
    const q = makeAnalysis<number, number>((a, b) => a === b);
    const r = makeAnalysis<number, number>((a, b) => a === b);

    const sibling = extend(extend(ROOT_CONTEXT, p, 1, 10), r, 3, 30);
    const full = extend(
      extend(extend(ROOT_CONTEXT, p, 1, 10), q, 2, 20),
      r, 3, 30,
    );

    expect(without(full, q, 2)).toBe(sibling);
  });

  it("replacement at same (narrowing, key): extend throws; use without+extend instead", () => {
    const p = makeAnalysis<number, number>((a, b) => a === b);
    const first = extend(ROOT_CONTEXT, p, 7, 10);

    expect(() => extend(first, p, 7, 20)).toThrow();

    const second = extend(without(first, p, 7), p, 7, 20);

    expect(first.depth).toBe(1);
    expect(second.depth).toBe(1);
    expect(second).not.toBe(first);
    expect(extend(first, p, 7, 10)).toBe(first);
  });

  it("rebuild dedups structurally-equal values across disjoint trie subtrees", () => {
    const ha = makeAnalysis<number, Boxed>(boxedEq);
    const hb = makeAnalysis<number, Boxed>(boxedEq);

    const ctxA = extend(extend(ROOT_CONTEXT, ha, 1, box(10)), hb, 1, box(20));
    const ctxB = extend(extend(ROOT_CONTEXT, hb, 1, box(20)), ha, 1, box(10));
    expect(ctxA).toBe(ctxB);
  });

  it("without on ctx with no match returns ctx unchanged (ref-equal)", () => {
    const p = makeAnalysis<number, number>((a, b) => a === b);
    const q = makeAnalysis<number, number>((a, b) => a === b);
    const c = extend(ROOT_CONTEXT, p, 1, 10);
    expect(without(c, q, 99)).toBe(c);
    expect(without(ROOT_CONTEXT, p, 1)).toBe(ROOT_CONTEXT);
  });

  it("interned nodes are frozen", () => {
    const p = makeAnalysis<number, number>((a, b) => a === b);
    const c = extend(ROOT_CONTEXT, p, 1, 10);
    expect(Object.isFrozen(c)).toBe(true);
    expect(Object.isFrozen(c.assumption)).toBe(true);
  });

  it("debugChainNodeCount monotonically tracks distinct interned chains", () => {
    const p = makeAnalysis<number, number>((a, b) => a === b);
    const before = debugChainNodeCount();
    extend(ROOT_CONTEXT, p, 9991, 10);
    extend(ROOT_CONTEXT, p, 9991, 10); // dedup
    extend(ROOT_CONTEXT, p, 9991, 10); // dedup
    expect(debugChainNodeCount()).toBe(before + 1);
    extend(ROOT_CONTEXT, p, 9991, 20); // distinct value
    expect(debugChainNodeCount()).toBe(before + 2);
  });
});

// Downstream-payoff: structurally-equal chains reach reference-equality, so
// `Map<AssumptionChain, _>` consumers (AnalysisStore's cellsByContext, the
// forked-body map) see the chain reconverge across widen → re-extend.
// Without canonicalization, step-3's chain would be a fresh object and the
// fact written at step-1 would be unreachable — a silent fact-cache orphan.
describe("interner reconvergence across widen → re-extend", () => {
  const intMax: JoinSemiLattice<number> = {
    bottom: 0,
    leq: (a, b) => a <= b,
    join: (a, b) => Math.max(a, b),
    eq: (a, b) => a === b,
  };

  it("fact written before widen is readable after re-extending the pruned link", () => {
    const nx = makeAnalysis<number, number>((a, b) => a === b);
    const ny = makeAnalysis<number, number>((a, b) => a === b);

    const c1 = extend(ROOT_CONTEXT, nx, 1, 1);
    const c2 = extend(c1, ny, 2, 2);

    const store = new AnalysisStore<string, number>(intMax, undefined);
    store.write("k", 42, c2);

    const widened = without(c2, ny, 2);
    expect(widened).toBe(c1);

    const c2Reborn = extend(widened, ny, 2, 2);
    expect(c2Reborn).toBe(c2);
    expect(store.tryRead("k", c2Reborn)).toBe(42);
  });

  it("order-independent observation reaches the same store partition", () => {
    const nx = makeAnalysis<number, number>((a, b) => a === b);
    const ny = makeAnalysis<number, number>((a, b) => a === b);

    const forward = extend(extend(ROOT_CONTEXT, nx, 1, 1), ny, 2, 2);
    const reverse = extend(extend(ROOT_CONTEXT, ny, 2, 2), nx, 1, 1);
    expect(forward).toBe(reverse);

    const store = new AnalysisStore<string, number>(intMax, undefined);
    store.write("k", 7, forward);
    expect(store.tryRead("k", reverse)).toBe(7);
  });
});

// `at` reads through the precomputed bindings map regardless of arrival order.
describe("at(s, narrowing, key)", () => {
  it("returns the pinned value across reorderings", () => {
    const p = makeAnalysis<number, number>((a, b) => a === b);
    const q = makeAnalysis<number, number>((a, b) => a === b);
    const s = extend(extend(ROOT_CONTEXT, p, 1, 10), q, 2, 20);
    expect(at(s, p, 1)).toBe(10);
    expect(at(s, q, 2)).toBe(20);
    expect(at(s, p, 2)).toBeUndefined();
  });
});
