import { Db, defineQuery } from "../../specialization/runtime";
import type { Lattice, QueryHandle } from "../../specialization/runtime";

const capLat: Lattice<number> = {
  bottom: 0,
  equals: (a, b) => a === b,
  join: (a, b) => Math.min(Math.max(a, b), 5),
};

const numLat: Lattice<number> = {
  bottom: 0,
  equals: (a, b) => a === b,
  join: (a, b) => Math.max(a, b),
};

describe("runtime/cycle", () => {
  test("cyclic query with cap converges", () => {
    const db = new Db();
    let self: QueryHandle<void, number> | null = null;
    const q = defineQuery<void, number>({
      name: "cycle.cap-converge",
      lattice: capLat,
      serialize: () => "()",
      fn: (d) => Math.min((self ? d.get(self, undefined) : 0) + 1, 5),
      isCyclic: true,
    });
    self = q;
    expect(db.get(q, undefined)).toBe(5);
  });

  test("non-cyclic query that recurses throws", () => {
    const db = new Db();
    let self: QueryHandle<void, number> | null = null;
    const q = defineQuery<void, number>({
      name: "cycle.non-cyclic-recurse",
      lattice: numLat,
      serialize: () => "()",
      fn: (d) => (self ? d.get(self, undefined) : 0) + 1,
    });
    self = q;
    expect(() => db.get(q, undefined)).toThrow(/Unexpected cycle/);
  });

  test("cross-query cycle A->B->A throws even when both isCyclic", () => {
    const db = new Db();
    let qA: QueryHandle<void, number> | null = null;
    let qB: QueryHandle<void, number> | null = null;
    qA = defineQuery<void, number>({
      name: "cycle.cross-a",
      lattice: capLat,
      serialize: () => "()",
      fn: (d) => qB ? d.get(qB, undefined) : 0,
      isCyclic: true,
    });
    qB = defineQuery<void, number>({
      name: "cycle.cross-b",
      lattice: capLat,
      serialize: () => "()",
      fn: (d) => qA ? d.get(qA, undefined) : 0,
      isCyclic: true,
    });
    expect(() => db.get(qA!, undefined)).toThrow(/[Cc]ross-query cycle/);
  });
});
