import { Db, defineInput, defineQuery } from "../../specialization/runtime";
import type { Lattice } from "../../specialization/runtime";

const numLat: Lattice<number> = {
  bottom: 0,
  equals: (a, b) => a === b,
  join: (a, b) => Math.max(a, b),
};

describe("runtime/introspection", () => {
  test("depsOf returns the cell-ids a query read on its last execution", () => {
    const db = new Db();
    const input = defineInput<string, number>("intro.depsOf-input", numLat, k => k);
    const q = defineQuery<void, number>({
      name: "intro.depsOf-q",
      lattice: numLat,
      serialize: () => "()",
      fn: (d) => input.get(d, "x") + input.get(d, "y"),
    });

    input.set(db, "x", 3);
    input.set(db, "y", 4);
    expect(db.get(q, undefined)).toBe(7);

    const qCellId = db.cellIdFor(q, undefined);
    const deps = db.depsOf(qCellId);

    expect(deps).toContain(db.cellIdFor(input, "x"));
    expect(deps).toContain(db.cellIdFor(input, "y"));
    expect(deps).toHaveLength(2);
  });

  test("dependentsOf returns the cell-ids that read a given cell", () => {
    const db = new Db();
    const input = defineInput<string, number>("intro.dependentsOf-input", numLat, k => k);
    const a = defineQuery<void, number>({
      name: "intro.dependentsOf-a",
      lattice: numLat,
      serialize: () => "()",
      fn: (d) => input.get(d, "k"),
    });
    const b = defineQuery<void, number>({
      name: "intro.dependentsOf-b",
      lattice: numLat,
      serialize: () => "()",
      fn: (d) => input.get(d, "k") * 2,
    });

    input.set(db, "k", 1);
    db.get(a, undefined);
    db.get(b, undefined);

    const inputCellId = db.cellIdFor(input, "k");
    const dependents = db.dependentsOf(inputCellId);

    expect(dependents.has(db.cellIdFor(a, undefined))).toBe(true);
    expect(dependents.has(db.cellIdFor(b, undefined))).toBe(true);
    expect(dependents.size).toBe(2);
  });

  test("dependentsOf reflects dep changes after re-execution", () => {
    const db = new Db();
    const x = defineInput<string, number>("intro.reflects-x", numLat, k => k);
    const y = defineInput<string, number>("intro.reflects-y", numLat, k => k);
    const switchInput = defineInput<string, number>("intro.reflects-switch", numLat, k => k);

    const q = defineQuery<void, number>({
      name: "intro.reflects-q",
      lattice: numLat,
      serialize: () => "()",
      fn: (d) => switchInput.get(d, "s") === 0 ? x.get(d, "v") : y.get(d, "v"),
    });

    x.set(db, "v", 10);
    y.set(db, "v", 20);
    switchInput.set(db, "s", 0);
    db.get(q, undefined);

    expect(db.dependentsOf(db.cellIdFor(x, "v")).has(db.cellIdFor(q, undefined))).toBe(true);
    expect(db.dependentsOf(db.cellIdFor(y, "v")).has(db.cellIdFor(q, undefined))).toBe(false);

    switchInput.set(db, "s", 1);
    db.get(q, undefined);

    expect(db.dependentsOf(db.cellIdFor(x, "v")).has(db.cellIdFor(q, undefined))).toBe(false);
    expect(db.dependentsOf(db.cellIdFor(y, "v")).has(db.cellIdFor(q, undefined))).toBe(true);
  });
});
