import { Db, defineInput, defineQuery } from "../../specialization/runtime";
import type { Lattice } from "../../specialization/runtime";

const numLat: Lattice<number> = {
  bottom: 0,
  equals: (a, b) => a === b,
  join: (a, b) => Math.max(a, b),
};

describe("runtime/invalidation", () => {
  test("chain Input -> A -> B -> C invalidates on input change", () => {
    const db = new Db();
    const input = defineInput<string, number>("invalidation.chain-input", numLat, k => k);

    let aCalls = 0, bCalls = 0, cCalls = 0;
    const a = defineQuery<void, number>({
      name: "invalidation.chain-a",
      lattice: numLat, serialize: () => "()",
      fn: (d) => { aCalls++; return input.get(d, "k") + 1; },
    });
    const b = defineQuery<void, number>({
      name: "invalidation.chain-b",
      lattice: numLat, serialize: () => "()",
      fn: (d) => { bCalls++; return d.get(a, undefined) + 1; },
    });
    const c = defineQuery<void, number>({
      name: "invalidation.chain-c",
      lattice: numLat, serialize: () => "()",
      fn: (d) => { cCalls++; return d.get(b, undefined) + 1; },
    });

    input.set(db, "k", 10);
    expect(db.get(c, undefined)).toBe(13);
    expect(aCalls).toBe(1); expect(bCalls).toBe(1); expect(cCalls).toBe(1);

    input.set(db, "k", 20);
    expect(db.get(c, undefined)).toBe(23);
    expect(aCalls).toBe(2); expect(bCalls).toBe(2); expect(cCalls).toBe(2);
  });

  test("independent queries: unrelated input does not invalidate", () => {
    const db = new Db();
    const in1 = defineInput<string, number>("invalidation.indep-in1", numLat, k => k);
    const in2 = defineInput<string, number>("invalidation.indep-in2", numLat, k => k);

    let q1Calls = 0, q2Calls = 0;
    const q1 = defineQuery<void, number>({
      name: "invalidation.indep-q1",
      lattice: numLat, serialize: () => "()",
      fn: (d) => { q1Calls++; return in1.get(d, "k"); },
    });
    const q2 = defineQuery<void, number>({
      name: "invalidation.indep-q2",
      lattice: numLat, serialize: () => "()",
      fn: (d) => { q2Calls++; return in2.get(d, "k"); },
    });

    in1.set(db, "k", 1);
    in2.set(db, "k", 100);
    db.get(q1, undefined);
    db.get(q2, undefined);
    expect(q1Calls).toBe(1); expect(q2Calls).toBe(1);

    in1.set(db, "k", 2);
    db.get(q1, undefined);
    db.get(q2, undefined);
    expect(q1Calls).toBe(2);
    expect(q2Calls).toBe(1);
  });
});
