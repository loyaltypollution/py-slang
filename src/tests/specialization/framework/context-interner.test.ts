import {
  ContextInterner,
} from "../../../specialization/framework/context-interner";
import {
  ROOT_CONTEXT,
  extendContext,
  excludeAssumption,
  findAssumption,
} from "../../../specialization/framework/context";
import type {
  Analysis,
  AnalysisCtx,
  Lattice,
} from "../../../specialization/framework/analysis";

const trivialLattice: Lattice<number> = {
  bottom: 0,
  leq: (a, b) => a <= b,
  join: (a, b) => Math.max(a, b),
  eq: (a, b) => a === b,
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

// Structural value type used to exercise value dedup: fresh objects per
// allocation, compared via lattice `eq`. Mirrors ConstLattice's shape.
interface Boxed { readonly v: number; }
const box = (v: number): Boxed => ({ v });
const boxedLattice: Lattice<Boxed> = {
  bottom: { v: -1 },
  leq: (a, b) => a.v <= b.v,
  join: (a, b) => ({ v: Math.max(a.v, b.v) }),
  eq: (a, b) => a === b || a.v === b.v,
};

describe("ContextInterner", () => {
  it("root is stable: extending from ROOT_CONTEXT never mints a new root", () => {
    const interner = new ContextInterner();
    const p = makeAnalysis<number, number>("p", trivialLattice);
    const c1 = interner.extend(ROOT_CONTEXT, p, 1, 10);
    expect(c1.parent).toBe(ROOT_CONTEXT);
  });

  it("same observation is idempotent: repeated extend returns ===", () => {
    const interner = new ContextInterner();
    const p = makeAnalysis<number, number>("p", trivialLattice);
    const a = interner.extend(ROOT_CONTEXT, p, 1, 10);
    const b = interner.extend(ROOT_CONTEXT, p, 1, 10);
    expect(a).toBe(b);
  });

  it("structurally-equal values dedup via lattice.eq", () => {
    const interner = new ContextInterner();
    const h = makeAnalysis<number, Boxed>("h", boxedLattice);
    // Fresh box objects: ref-different but lattice-equal (same .v).
    // boxedLattice.eq handles the structural comparison.
    const a = interner.extend(ROOT_CONTEXT, h, 1, box(42));
    const b = interner.extend(ROOT_CONTEXT, h, 1, box(42));
    expect(a).toBe(b);
  });

  it("order-independence: same assumption set → same canonical chain", () => {
    const interner = new ContextInterner();
    const p = makeAnalysis<number, number>("p", trivialLattice);
    const q = makeAnalysis<number, number>("q", trivialLattice);
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
    const interner = new ContextInterner();
    const p = makeAnalysis<number, number>("p", trivialLattice);
    const q = makeAnalysis<number, number>("q", trivialLattice);
    const r = makeAnalysis<number, number>("r", trivialLattice);

    // Pre-build the sibling: {p@1, r@3}. Distinct (debugName, key) pairs.
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

  it("replacement at same (handle, key): depth unchanged, not layered", () => {
    const interner = new ContextInterner();
    const p = makeAnalysis<number, number>("p", trivialLattice);
    const first = interner.extend(ROOT_CONTEXT, p, 7, 10);
    const second = interner.extend(first, p, 7, 20);

    expect(first.depth).toBe(1);
    expect(second.depth).toBe(1);
    expect(second).not.toBe(first); // different value → different canonical node
    expect(findAssumption(second, p, 7)).toBe(20);
  });

  it("rebuild dedups structurally-equal values across disjoint trie subtrees", () => {
    // Regression: rebuilds that walk through a non-target link whose value
    // is structurally equal to a trie entry under a DIFFERENT parent path
    // must use lattice.eq, not ref-equality. Otherwise two arrival orders
    // reaching the same canonical chain would fork the trie.
    const interner = new ContextInterner();
    const ha = makeAnalysis<number, Boxed>("a-handle", boxedLattice);
    const hb = makeAnalysis<number, Boxed>("b-handle", boxedLattice);

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
    const interner = new ContextInterner();
    const p = makeAnalysis<number, number>("p", trivialLattice);
    const q = makeAnalysis<number, number>("q", trivialLattice);
    const c = interner.extend(ROOT_CONTEXT, p, 1, 10);
    expect(interner.exclude(c, q, 99)).toBe(c);
    expect(interner.exclude(ROOT_CONTEXT, p, 1)).toBe(ROOT_CONTEXT);
  });

  it("interned nodes are frozen", () => {
    const interner = new ContextInterner();
    const p = makeAnalysis<number, number>("p", trivialLattice);
    const c = interner.extend(ROOT_CONTEXT, p, 1, 10);
    expect(Object.isFrozen(c)).toBe(true);
    expect(Object.isFrozen(c.assumption)).toBe(true);
  });

  it("interner instances are isolated (no cross-instance sharing)", () => {
    const a = new ContextInterner();
    const b = new ContextInterner();
    const p = makeAnalysis<number, number>("p", trivialLattice);
    const ca = a.extend(ROOT_CONTEXT, p, 1, 10);
    const cb = b.extend(ROOT_CONTEXT, p, 1, 10);
    // Same structural content but different interner instances ⇒ different nodes.
    expect(ca).not.toBe(cb);
  });

  it("debugNodeCount reflects interned chain count, not call count", () => {
    const interner = new ContextInterner();
    const p = makeAnalysis<number, number>("p", trivialLattice);
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
    const p = makeAnalysis<number, number>("context-interner-p", trivialLattice);
    const a = extendContext(ROOT_CONTEXT, p, 1, 10);
    const b = extendContext(ROOT_CONTEXT, p, 1, 10);
    expect(a).toBe(b);
  });

  it("excludeAssumption via free function yields canonical sibling", () => {
    const p = makeAnalysis<number, number>("context-interner-ff-p", trivialLattice);
    const q = makeAnalysis<number, number>("context-interner-ff-q", trivialLattice);
    const r = makeAnalysis<number, number>("context-interner-ff-r", trivialLattice);
    const sibling = extendContext(
      extendContext(ROOT_CONTEXT, p, 1, 10),
      r, 3, 30,
    );
    const full = extendContext(
      extendContext(
        extendContext(ROOT_CONTEXT, p, 1, 10),
        q, 2, 20,
      ),
      r, 3, 30,
    );
    expect(excludeAssumption(full, q, 2)).toBe(sibling);
  });
});
