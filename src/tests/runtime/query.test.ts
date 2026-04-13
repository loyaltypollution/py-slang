import { Db, defineInput, defineQuery } from "../../specialization/runtime";
import type { Lattice } from "../../specialization/runtime";

const numLat: Lattice<number> = {
  bottom: 0,
  equals: (a, b) => a === b,
  join: (a, b) => Math.max(a, b),
};

describe("runtime/query", () => {
  test("pure no-dep query is memoized", () => {
    const db = new Db();
    let calls = 0;
    const q = defineQuery<void, number>({
      name: "query.pure-memo",
      lattice: numLat,
      serialize: () => "()",
      fn: () => { calls++; return 7; },
    });
    expect(db.get(q, undefined)).toBe(7);
    expect(db.get(q, undefined)).toBe(7);
    expect(calls).toBe(1);
  });

  test("dep recording: query reading input records input cell-id", () => {
    const db = new Db();
    const input = defineInput<string, number>("query.dep-input", numLat, k => k);
    const q = defineQuery<void, number>({
      name: "query.dep",
      lattice: numLat,
      serialize: () => "()",
      fn: (d) => input.get(d, "x"),
    });
    input.set(db, "x", 5);
    db.get(q, undefined);
    const qCellId = db.cellIdFor(q, undefined);
    const inputCellId = db.cellIdFor({ id: input.id, serialize: input.serialize }, "x");
    expect(db.depsOf(qCellId)).toContain(inputCellId);
  });

  test("memoization invalidates on Input.set", () => {
    const db = new Db();
    const input = defineInput<string, number>("query.inv-input", numLat, k => k);
    let calls = 0;
    const q = defineQuery<void, number>({
      name: "query.inv",
      lattice: numLat,
      serialize: () => "()",
      fn: (d) => { calls++; return input.get(d, "x") + 1; },
    });

    input.set(db, "x", 10);
    expect(db.get(q, undefined)).toBe(11);
    expect(calls).toBe(1);

    expect(db.get(q, undefined)).toBe(11);
    expect(calls).toBe(1);

    input.set(db, "x", 20);
    expect(db.get(q, undefined)).toBe(21);
    expect(calls).toBe(2);
  });
});
