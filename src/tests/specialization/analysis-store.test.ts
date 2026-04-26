/**
 * AnalysisStore unit tests.
 *
 * Storage primitive: context-partitioned cells, algebra-gated writes,
 * `{prev, next} | null` return that the worklist lifts into change events.
 * Previously these behaviors lived in `FactStore`; after the citizen split
 * and the FactStore delete, they are anchored on `AnalysisStore` directly.
 */
import { AnalysisStore } from "../../specialization/framework/analysis-store";
import type { JoinSemiLattice } from "../../specialization/framework/analysis";
import { extend, ROOT_CONTEXT, type NarrowingAxis } from "../../specialization/assumption/chain";

const intMaxLattice: JoinSemiLattice<number> = {
  bottom: 0,
  leq: (a, b) => a <= b,
  join: (a, b) => Math.max(a, b),
  eq: (a, b) => a === b,
};

const firedLattice: JoinSemiLattice<"fired"> = {
  bottom: "fired",
  leq: () => true,
  join: () => "fired",
  eq: () => true,
};

const intMinCombine: JoinSemiLattice<number> = {
  bottom: Number.POSITIVE_INFINITY,
  leq: (a, b) => a <= b,
  join: (a, b) => Math.min(a, b),
  eq: (a, b) => a === b,
};

function makeHandle<K, V>(_name: string, eq: (a: V, b: V) => boolean): NarrowingAxis<K, V> {
  return { eq };
}

describe("AnalysisStore", () => {
  it("returns algebra.bottom for an unwritten cell", () => {
    const store = new AnalysisStore<string, number>(intMaxLattice, undefined);
    expect(store.read("k", ROOT_CONTEXT)).toBe(0);
    expect(store.readAll(ROOT_CONTEXT).has("k")).toBe(false);
  });

  it("honors emptyValue over algebra.bottom when set", () => {
    const store = new AnalysisStore<string, number>(intMaxLattice, 42);
    expect(store.read("k", ROOT_CONTEXT)).toBe(42);
  });

  it("returns {prev, next} on first write", () => {
    const store = new AnalysisStore<string, number>(intMaxLattice, undefined);
    const result = store.write("k", 3, ROOT_CONTEXT);
    expect(result).toEqual({ prev: undefined, next: 3 });
  });

  it("returns null when a write does not advance the cell", () => {
    const store = new AnalysisStore<string, number>(intMaxLattice, undefined);
    store.write("k", 3, ROOT_CONTEXT);
    expect(store.write("k", 3, ROOT_CONTEXT)).toBeNull();
  });

  it("returns {prev, next} when the joined value advances", () => {
    const store = new AnalysisStore<string, number>(intMaxLattice, undefined);
    store.write("k", 3, ROOT_CONTEXT);
    expect(store.write("k", 5, ROOT_CONTEXT)).toEqual({ prev: 3, next: 5 });
  });

  it("top-only algebras converge after first write", () => {
    const store = new AnalysisStore<string, "fired">(firedLattice, undefined);
    expect(store.write("n1", "fired", ROOT_CONTEXT)).toEqual({ prev: undefined, next: "fired" });
    expect(store.write("n1", "fired", ROOT_CONTEXT)).toBeNull();
    expect(store.write("n1", "fired", ROOT_CONTEXT)).toBeNull();
  });

  it("compares against the actual joined value, not leq(value, prev)", () => {
    // Must-style combine: `min` can still advance even when incoming <= prev
    // under leq. The eq-gate on the joined value is the right test.
    const store = new AnalysisStore<string, number>(intMinCombine, undefined);
    store.write("k", 7, ROOT_CONTEXT);
    const result = store.write("k", 3, ROOT_CONTEXT);
    expect(result).toEqual({ prev: 7, next: 3 });
    expect(store.read("k", ROOT_CONTEXT)).toBe(3);
  });

  it("readAll returns the full keyspace at the context", () => {
    const store = new AnalysisStore<string, number>(intMaxLattice, undefined);
    store.write("a", 1, ROOT_CONTEXT);
    store.write("b", 2, ROOT_CONTEXT);
    const all = store.readAll(ROOT_CONTEXT);
    expect(all.size).toBe(2);
    expect(all.get("a")).toBe(1);
    expect(all.get("b")).toBe(2);
  });

  it("evict drops a cell silently", () => {
    const store = new AnalysisStore<string, number>(intMaxLattice, undefined);
    store.write("k", 9, ROOT_CONTEXT);
    store.evict("k", ROOT_CONTEXT);
    expect(store.readAll(ROOT_CONTEXT).has("k")).toBe(false);
    expect(store.read("k", ROOT_CONTEXT)).toBe(0);
  });

  describe("context dimension", () => {
    const handle = makeHandle<string, number>("p-handle", (a, b) => a === b);

    it("isolates cells at different contexts for the same key", () => {
      const store = new AnalysisStore<string, number>(intMaxLattice, undefined);
      const ctx = extend(ROOT_CONTEXT, handle, "k", 99);

      store.write("k", 3, ROOT_CONTEXT);
      store.write("k", 7, ctx);

      expect(store.read("k", ROOT_CONTEXT)).toBe(3);
      expect(store.read("k", ctx)).toBe(7);
    });

    it("readAll partitions by context", () => {
      const store = new AnalysisStore<string, number>(intMaxLattice, undefined);
      const ctx = extend(ROOT_CONTEXT, handle, "k", 99);

      store.write("a", 1, ROOT_CONTEXT);
      store.write("b", 2, ctx);

      expect(Array.from(store.readAll(ROOT_CONTEXT).keys())).toEqual(["a"]);
      expect(Array.from(store.readAll(ctx).keys())).toEqual(["b"]);
    });

    it("evict is context-scoped", () => {
      const store = new AnalysisStore<string, number>(intMaxLattice, undefined);
      const ctx = extend(ROOT_CONTEXT, handle, "k", 99);

      store.write("k", 1, ROOT_CONTEXT);
      store.write("k", 2, ctx);
      store.evict("k", ctx);

      expect(store.read("k", ROOT_CONTEXT)).toBe(1);
      expect(store.readAll(ctx).has("k")).toBe(false);
    });

    it("unwritten cell at a context returns the default, not the parent cell", () => {
      const store = new AnalysisStore<string, number>(intMaxLattice, undefined);
      const ctx = extend(ROOT_CONTEXT, handle, "k", 99);

      store.write("k", 5, ROOT_CONTEXT);

      // Non-ROOT cell unwritten → falls back to algebra.bottom, not the
      // ROOT cell. Seeding across contexts is a caller-level decision.
      expect(store.read("k", ctx)).toBe(0);
    });
  });
});
