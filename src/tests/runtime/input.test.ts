import { Db, defineInput } from "../../specialization/runtime";
import type { Lattice } from "../../specialization/runtime";

const numLat: Lattice<number> = {
  bottom: 0,
  equals: (a, b) => a === b,
  join: (a, b) => Math.max(a, b),
};

describe("runtime/input", () => {
  test("set then get returns the value", () => {
    const db = new Db();
    const input = defineInput<string, number>("input.basic-set-get", numLat, k => k);
    input.set(db, "k", 42);
    expect(input.get(db, "k")).toBe(42);
  });

  test("revision bumps on value change; not on lattice-equal write", () => {
    const db = new Db();
    const input = defineInput<string, number>("input.revision-bump", numLat, k => k);

    const r0 = db.currentRevision();
    input.set(db, "k", 1);
    const r1 = db.currentRevision();
    expect((r1 as number)).toBeGreaterThan(r0 as number);

    input.set(db, "k", 1);
    const r2 = db.currentRevision();
    expect(r2).toBe(r1);

    input.set(db, "k", 2);
    const r3 = db.currentRevision();
    expect((r3 as number)).toBeGreaterThan(r2 as number);
  });

  test("get before any set returns lattice.bottom", () => {
    const db = new Db();
    const input = defineInput<string, number>("input.bottom", numLat, k => k);
    expect(input.get(db, "missing")).toBe(0);
  });
});
