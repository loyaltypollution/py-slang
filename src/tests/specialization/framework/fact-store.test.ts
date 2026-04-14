/**
 * PR-1 scope: `FactStore` + `Pass<K, V>` primitives are additive. No
 * integration with `Worklist` yet — these tests exercise the store in
 * isolation. Behaviors covered:
 *   (a) read-before-write returns the pass's lattice bottom;
 *   (b) equality-gated writes suppress no-op change events;
 *   (c) change events carry the expected payload shape;
 *   (d) `readAll` surfaces all written keys for a pass;
 *   (e) `evict` drops a cell without firing events.
 */
import { FactStore, type FactChange } from "../../../specialization/framework/fact-store";
import type { Lattice, Pass, PassCtx } from "../../../specialization/framework/pass";

// ---------------------------------------------------------------------------
// Fixtures: a monotone int-max lattice and a top-only "fired" lattice.
// ---------------------------------------------------------------------------
const intMaxLattice: Lattice<number> = {
  bottom: 0,
  leq: (a, b) => a <= b,
  join: (a, b) => Math.max(a, b),
};

const firedLattice: Lattice<"fired"> = {
  bottom: "fired",
  leq: () => true,
  join: () => "fired",
};

function makePass<K, V>(
  name: string,
  lattice: Lattice<V>,
  transfer: (factStore: FactStore, ctx: PassCtx, key: K) => V | undefined = () => undefined,
): Pass<K, V> {
  return {
    id: Symbol(name),
    debugName: name,
    lattice,
    edges: [],
    tier: "analysis",
    transfer,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe("FactStore", () => {
  it("returns lattice.bottom for an unwritten cell", () => {
    const store = new FactStore();
    const p = makePass<string, number>("p", intMaxLattice);
    expect(store.read(p, "k")).toBe(0);
    expect(store.readAll(p).has("k")).toBe(false);
  });

  it("fires onChange with correct payload on first write", () => {
    const store = new FactStore();
    const p = makePass<string, number>("p", intMaxLattice);
    const events: FactChange<unknown, unknown>[] = [];
    store.onChange(e => events.push(e));

    const changed = store.write(p, "k", 3);
    expect(changed).toBe(true);
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({ pass: p, key: "k", oldValue: undefined, newValue: 3 });
  });

  it("suppresses events on equal-value writes", () => {
    const store = new FactStore();
    const p = makePass<string, number>("p", intMaxLattice);
    const events: FactChange<unknown, unknown>[] = [];
    store.onChange(e => events.push(e));

    store.write(p, "k", 3);
    const changed = store.write(p, "k", 3);
    expect(changed).toBe(false);
    expect(events).toHaveLength(1);
  });

  it("fires onChange when value changes under lattice.equals", () => {
    const store = new FactStore();
    const p = makePass<string, number>("p", intMaxLattice);
    const events: FactChange<unknown, unknown>[] = [];
    store.onChange(e => events.push(e));

    store.write(p, "k", 3);
    store.write(p, "k", 5);
    expect(events).toHaveLength(2);
    expect(events[1]).toEqual({ pass: p, key: "k", oldValue: 3, newValue: 5 });
  });

  it("treats top-only lattices as converged after the first write", () => {
    const store = new FactStore();
    const p = makePass<string, "fired">("rule", firedLattice);
    let eventCount = 0;
    store.onChange(() => eventCount++);

    store.write(p, "n1", "fired");
    store.write(p, "n1", "fired");
    store.write(p, "n1", "fired");
    expect(eventCount).toBe(1);
  });

  it("keeps different passes' keyspaces independent", () => {
    const store = new FactStore();
    const p1 = makePass<string, number>("p1", intMaxLattice);
    const p2 = makePass<string, number>("p2", intMaxLattice);

    store.write(p1, "k", 7);
    expect(store.read(p2, "k")).toBe(0);
    expect(store.readAll(p2).has("k")).toBe(false);
  });

  it("readAll returns the pass's full keyspace", () => {
    const store = new FactStore();
    const p = makePass<string, number>("p", intMaxLattice);
    store.write(p, "a", 1);
    store.write(p, "b", 2);

    const all = store.readAll(p);
    expect(all.size).toBe(2);
    expect(all.get("a")).toBe(1);
    expect(all.get("b")).toBe(2);
  });

  it("evict drops a cell silently", () => {
    const store = new FactStore();
    const p = makePass<string, number>("p", intMaxLattice);
    store.write(p, "k", 9);

    const events: FactChange<unknown, unknown>[] = [];
    store.onChange(e => events.push(e));

    store.evict(p, "k");
    expect(store.readAll(p).has("k")).toBe(false);
    expect(store.read(p, "k")).toBe(0);
    expect(events).toHaveLength(0);
  });

  it("unsubscribing a listener stops further notifications", () => {
    const store = new FactStore();
    const p = makePass<string, number>("p", intMaxLattice);
    let count = 0;
    const off = store.onChange(() => count++);

    store.write(p, "k", 1);
    off();
    store.write(p, "k", 2);
    expect(count).toBe(1);
  });
});
