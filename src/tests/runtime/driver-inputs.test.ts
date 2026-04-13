import { StmtNS } from "../../ast-types";
import { parse } from "../../parser/parser-adapter";
import {
  Db,
  astOf,
  defineQuery,
  runtimeCall,
  runtimeWrite,
} from "../../specialization/runtime";
import type { Lattice } from "../../specialization/runtime";

const astReadLattice: Lattice<StmtNS.FileInput | undefined> = {
  bottom: undefined,
  equals: (a, b) => a === b,
  join: (_a, b) => b,
};

const unknownLattice: Lattice<unknown> = {
  bottom: undefined,
  equals: (a, b) => a === b,
  join: (_a, b) => b,
};

const numLattice: Lattice<number> = {
  bottom: 0,
  equals: (a, b) => a === b,
  join: (a, b) => Math.max(a, b),
};

describe("runtime/driver-inputs", () => {
  test("astOf round-trip via query", () => {
    const db = new Db();
    const mockAst = parse("x = 1\n");

    astOf.set(db, 0, mockAst);

    const readAst = defineQuery<number, StmtNS.FileInput | undefined>({
      name: "test.readAst",
      lattice: astReadLattice,
      serialize: String,
      fn: (d, u) => astOf.get(d, u),
    });

    expect(db.get(readAst, 0)).toBe(mockAst);
  });

  test("runtimeWrite stores observation per nodeId", () => {
    const db = new Db();

    runtimeWrite.set(db, 42, "hello");
    runtimeWrite.set(db, 99, 7);

    const readWrite = defineQuery<number, unknown>({
      name: "test.readWrite",
      lattice: unknownLattice,
      serialize: String,
      fn: (d, n) => runtimeWrite.get(d, n),
    });

    expect(db.get(readWrite, 42)).toBe("hello");
    expect(db.get(readWrite, 99)).toBe(7);
  });

  test("runtimeCall saturates at 50; downstream stops re-running past saturation", () => {
    const db = new Db();
    const scope = 7;

    let downstreamCalls = 0;
    const downstream = defineQuery<number, number>({
      name: "test.downstream",
      lattice: numLattice,
      serialize: String,
      fn: (d, s) => {
        downstreamCalls++;
        return runtimeCall.get(d, s);
      },
    });

    runtimeCall.set(db, scope, 1);
    expect(db.get(downstream, scope)).toBe(1);
    runtimeCall.set(db, scope, 25);
    expect(db.get(downstream, scope)).toBe(25);
    runtimeCall.set(db, scope, 49);
    expect(db.get(downstream, scope)).toBe(49);
    runtimeCall.set(db, scope, 50);
    expect(db.get(downstream, scope)).toBe(50);

    const callsAtSaturation = downstreamCalls;

    runtimeCall.set(db, scope, 51);
    expect(db.get(downstream, scope)).toBe(50);
    runtimeCall.set(db, scope, 99);
    expect(db.get(downstream, scope)).toBe(50);

    expect(downstreamCalls).toBe(callsAtSaturation);
  });

  test("lattice-equal write of AST suppresses revision bump", () => {
    const db = new Db();
    const mockAst = parse("y = 2\n");

    astOf.set(db, 0, mockAst);
    const revAfterFirst = db.currentRevision();

    astOf.set(db, 0, mockAst);
    expect(db.currentRevision()).toBe(revAfterFirst);
  });
});
