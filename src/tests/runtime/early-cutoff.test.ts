import { Db, defineInput, defineQuery } from "../../specialization/runtime";
import type { Lattice } from "../../specialization/runtime";

const saturating: Lattice<number> = {
  bottom: 0,
  equals: (a, b) => a === b,
  join: (a, b) => Math.min(a + b, 50),
};

const numLat: Lattice<number> = {
  bottom: 0,
  equals: (a, b) => a === b,
  join: (a, b) => Math.max(a, b),
};

const strLat: Lattice<string> = {
  bottom: "",
  equals: (a, b) => a === b,
  join: (a, b) => a === b ? a : (a < b ? b : a),
};

describe("runtime/early-cutoff", () => {
  test("O(1) past saturation: downstream does not re-run", () => {
    const db = new Db();
    const inputA = defineInput<string, number>("early-cutoff.input", saturating, k => k);

    let midCalls = 0;
    const queryMid = defineQuery<void, number>({
      name: "early-cutoff.mid",
      lattice: numLat,
      serialize: () => "()",
      fn: (d) => { midCalls++; return Math.min(inputA.get(d, "x"), 50); },
    });

    let topCalls = 0;
    const queryTop = defineQuery<void, string>({
      name: "early-cutoff.top",
      lattice: strLat,
      serialize: () => "()",
      fn: (d) => { topCalls++; return db.get(queryMid, undefined) >= 50 ? "hot" : "cold"; },
    });

    inputA.set(db, "x", 51);
    expect(db.get(queryTop, undefined)).toBe("hot");
    const topAfterFirst = topCalls;
    expect(topAfterFirst).toBe(1);

    inputA.set(db, "x", 99);
    expect(db.get(queryTop, undefined)).toBe("hot");
    expect(topCalls).toBe(topAfterFirst);
    expect(midCalls).toBeGreaterThanOrEqual(2);
  });
});
