import type { JoinSemiLattice } from "../../specialization/framework/analysis";
import { AnalysisStore } from "../../specialization/framework/analysis-store";
import { ROOT_CONTEXT } from "../../specialization/assumption/chain";
import {
  at,
  extend as extendAlg,
  without,
} from "../../specialization/assumption/algebra";
import {
  ChainInterner,
} from "../../specialization/assumption/interner";
import {
  box,
  boxedEq,
  makeNarrowing as makeAnalysis,
  type Boxed,
} from "./harness/lattice-doubles";

describe("ChainInterner", () => {
  it("root is stable: extending from ROOT_CONTEXT never mints a new root", () => {
    const interner = new ChainInterner();
    const p = makeAnalysis<number, number>((a, b) => a === b);
    const c1 = interner.extend(ROOT_CONTEXT, p, 1, 10);
    expect(c1.parent).toBe(ROOT_CONTEXT);
  });

  it("same observation is idempotent: repeated extend returns ===", () => {
    const interner = new ChainInterner();
    const p = makeAnalysis<number, number>((a, b) => a === b);
    const a = interner.extend(ROOT_CONTEXT, p, 1, 10);
    const b = interner.extend(ROOT_CONTEXT, p, 1, 10);
    expect(a).toBe(b);
  });

  it("structurally-equal values dedup via lattice.eq", () => {
    const interner = new ChainInterner();
    const h = makeAnalysis<number, Boxed>(boxedEq);
    const a = interner.extend(ROOT_CONTEXT, h, 1, box(42));
    const b = interner.extend(ROOT_CONTEXT, h, 1, box(42));
    expect(a).toBe(b);
  });

  it("order-independence: same assumption set → same canonical chain", () => {
    const interner = new ChainInterner();
    const p = makeAnalysis<number, number>((a, b) => a === b);
    const q = makeAnalysis<number, number>((a, b) => a === b);
    // Build "forward": p@1 then q@2.
    const forward = interner.extend(
      interner.extend(ROOT_CONTEXT, p, 1, 10),
      q, 2, 20,
    );
    // Build "backward": q@2 first, then p@1 (which sorts earlier → rebuild).
    const backward = interner.extend(
      interner.extend(ROOT_CONTEXT, q, 2, 20),
      p, 1, 10,
    );
    expect(forward).toBe(backward);
  });

  it("exclude returns pre-built sibling (the chain→tree payoff)", () => {
    const interner = new ChainInterner();
    const p = makeAnalysis<number, number>((a, b) => a === b);
    const q = makeAnalysis<number, number>((a, b) => a === b);
    const r = makeAnalysis<number, number>((a, b) => a === b);

    // Pre-build the sibling: {p@1, r@3}. Distinct (narrowing, key) pairs.
    const sibling = interner.extend(
      interner.extend(ROOT_CONTEXT, p, 1, 10),
      r, 3, 30,
    );

    // Build the full chain: {p@1, q@2, r@3}.
    const full = interner.extend(
      interner.extend(
        interner.extend(ROOT_CONTEXT, p, 1, 10),
        q, 2, 20,
      ),
      r, 3, 30,
    );

    const pruned = interner.exclude(full, q, 2);
    expect(pruned).toBe(sibling);
  });

  it("replacement at same (handle, key): extend throws; use exclude+extend instead", () => {
    const interner = new ChainInterner();
    const p = makeAnalysis<number, number>((a, b) => a === b);
    const first = interner.extend(ROOT_CONTEXT, p, 7, 10);

    // Strict mode: a direct conflicting extend is a bug at the caller.
    expect(() => interner.extend(first, p, 7, 20)).toThrow();

    // The worklist's retire + exclude + extend pattern is the supported path.
    const second = interner.extend(interner.exclude(first, p, 7), p, 7, 20);

    expect(first.depth).toBe(1);
    expect(second.depth).toBe(1);
    expect(second).not.toBe(first); // different value → different canonical node
    // Idempotent extend (same value) returns the same node.
    expect(interner.extend(first, p, 7, 10)).toBe(first);
  });

  it("rebuild dedups structurally-equal values across disjoint trie subtrees", () => {
    // Regression: rebuilds that walk through a non-target link whose value
    // is structurally equal to a trie entry under a DIFFERENT parent path
    // must use lattice.eq, not ref-equality. Otherwise two arrival orders
    // reaching the same canonical chain would fork the trie.
    const interner = new ChainInterner();
    const ha = makeAnalysis<number, Boxed>(boxedEq);
    const hb = makeAnalysis<number, Boxed>(boxedEq);

    // Path A: a@1=box(10), then b@1=box(20) (already canonical — append path).
    const ctxA = interner.extend(
      interner.extend(ROOT_CONTEXT, ha, 1, box(10)),
      hb, 1, box(20),
    );
    // Path B: b@1=box(20) first, then a@1=box(10) (a < b canonically — rebuild
    // path). The rebuild re-interns box(20) under ROOT→a@1=box(10), which is
    // a different subtree than path A created. lattice.eq finds the
    // canonical sibling.
    const ctxB = interner.extend(
      interner.extend(ROOT_CONTEXT, hb, 1, box(20)),
      ha, 1, box(10),
    );
    expect(ctxA).toBe(ctxB);
  });

  it("exclude on ctx with no match returns ctx unchanged (ref-equal)", () => {
    const interner = new ChainInterner();
    const p = makeAnalysis<number, number>((a, b) => a === b);
    const q = makeAnalysis<number, number>((a, b) => a === b);
    const c = interner.extend(ROOT_CONTEXT, p, 1, 10);
    expect(interner.exclude(c, q, 99)).toBe(c);
    expect(interner.exclude(ROOT_CONTEXT, p, 1)).toBe(ROOT_CONTEXT);
  });

  it("interned nodes are frozen", () => {
    const interner = new ChainInterner();
    const p = makeAnalysis<number, number>((a, b) => a === b);
    const c = interner.extend(ROOT_CONTEXT, p, 1, 10);
    expect(Object.isFrozen(c)).toBe(true);
    expect(Object.isFrozen(c.assumption)).toBe(true);
  });

  it("interner instances are isolated (no cross-instance sharing)", () => {
    const a = new ChainInterner();
    const b = new ChainInterner();
    const p = makeAnalysis<number, number>((a, b) => a === b);
    const ca = a.extend(ROOT_CONTEXT, p, 1, 10);
    const cb = b.extend(ROOT_CONTEXT, p, 1, 10);
    // Same structural content but different interner instances ⇒ different nodes.
    expect(ca).not.toBe(cb);
  });

  it("debugNodeCount reflects interned chain count, not call count", () => {
    const interner = new ChainInterner();
    const p = makeAnalysis<number, number>((a, b) => a === b);
    interner.extend(ROOT_CONTEXT, p, 1, 10);
    interner.extend(ROOT_CONTEXT, p, 1, 10); // dedup
    interner.extend(ROOT_CONTEXT, p, 1, 10); // dedup
    expect(interner.debugNodeCount()).toBe(1);
    interner.extend(ROOT_CONTEXT, p, 1, 20); // distinct value ⇒ new node
    expect(interner.debugNodeCount()).toBe(2);
  });
});

describe("default interner via free functions", () => {
  it("extendContext dedups structurally-equal chains through the module singleton", () => {
    const p = makeAnalysis<number, number>(( a: number, b: number) => a === b);
    const a = extendAlg(ROOT_CONTEXT, p, 1, 10);
    const b = extendAlg(ROOT_CONTEXT, p, 1, 10);
    expect(a).toBe(b);
  });

  it("excludeAssumption via free function yields canonical sibling", () => {
    const p = makeAnalysis<number, number>(( a: number, b: number) => a === b);
    const q = makeAnalysis<number, number>(( a: number, b: number) => a === b);
    const r = makeAnalysis<number, number>(( a: number, b: number) => a === b);
    const sibling = extendAlg(
      extendAlg(ROOT_CONTEXT, p, 1, 10),
      r, 3, 30,
    );
    const full = extendAlg(
      extendAlg(
        extendAlg(ROOT_CONTEXT, p, 1, 10),
        q, 2, 20,
      ),
      r, 3, 30,
    );
    expect(without(full, q, 2)).toBe(sibling);
  });
});

// Downstream-payoff tests. The interner's value proposition is that
// structurally-equal chains reach reference-equality, so downstream
// `Map<AssumptionChain, _>` consumers (here: AnalysisStore's cellsByContext)
// see the chain reconverge across widen → re-extend. Without the interner,
// step-3's chain would be a fresh object and the fact written at step-1
// would be unreachable — a silent fact-cache orphan on every successful
// re-speculation.
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

    const c1 = extendAlg(ROOT_CONTEXT, nx, 1, 1);
    const c2 = extendAlg(c1, ny, 2, 2);

    const store = new AnalysisStore<string, number>(intMax, undefined);
    store.write("k", 42, c2);

    const widened = without(c2, ny, 2);
    expect(widened).toBe(c1);

    // Re-observe y. Must land on the same chain node c2 so the fact
    // cached at step-1 is still reachable — the JIT IR cache and
    // forked-body map (both keyed the same way) ride on this invariant.
    const c2Reborn = extendAlg(widened, ny, 2, 2);
    expect(c2Reborn).toBe(c2);
    expect(store.tryRead("k", c2Reborn)).toBe(42);
  });

  it("order-independent observation reaches the same store partition", () => {
    const nx = makeAnalysis<number, number>((a, b) => a === b);
    const ny = makeAnalysis<number, number>((a, b) => a === b);

    // Site A observes x then y; site B observes y then x. Same set, two
    // extend orders. A per-unit store keyed by chain must see one cell,
    // not two.
    const forward = extendAlg(extendAlg(ROOT_CONTEXT, nx, 1, 1), ny, 2, 2);
    const reverse = extendAlg(extendAlg(ROOT_CONTEXT, ny, 2, 2), nx, 1, 1);
    expect(forward).toBe(reverse);

    const store = new AnalysisStore<string, number>(intMax, undefined);
    store.write("k", 7, forward);
    expect(store.tryRead("k", reverse)).toBe(7);
  });
});
