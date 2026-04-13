import { parse } from "../../parser/parser-adapter";
import { buildCFG, type CFG } from "../../specialization/framework/cfg";
import {
  Db,
  astOf,
  cfgOf,
  defineQuery,
} from "../../specialization/runtime";
import type { Lattice, QueryHandle } from "../../specialization/runtime";

const cfgLattice: Lattice<CFG | undefined> = {
  bottom: undefined,
  equals: (a, b) => a === b,
  join: (_a, b) => b,
};

function makeCountingCfgOf(): {
  handle: QueryHandle<number, CFG | undefined>;
  getCount: () => number;
} {
  let count = 0;
  const handle = defineQuery<number, CFG | undefined>({
    name: "test.cfgOfCounting",
    lattice: cfgLattice,
    serialize: String,
    fn: (db, unitId) => {
      const ast = astOf.get(db, unitId);
      if (ast === undefined) {
        throw new Error(`no AST for unit ${unitId}`);
      }
      count++;
      return buildCFG(ast.statements);
    },
  });
  return { handle, getCount: () => count };
}

describe("runtime/queries/cfgOf", () => {
  test("builds CFG from set AST", () => {
    const db = new Db();
    const ast = parse("x = 1\ny = 2\n");
    astOf.set(db, 0, ast);

    const cfg = db.get(cfgOf, 0);
    expect(cfg).toBeDefined();
    expect(cfg!.entry).toBeDefined();
    expect(cfg!.exit).toBeDefined();
    expect(cfg!.entry).not.toBe(cfg!.exit);
    expect(cfg!.blocks.length).toBeGreaterThanOrEqual(1);
  });

  test("memoizes: consecutive gets return same CFG reference", () => {
    const db = new Db();
    const ast = parse("x = 1\n");
    astOf.set(db, 0, ast);

    const first = db.get(cfgOf, 0);
    const second = db.get(cfgOf, 0);
    expect(second).toBe(first);
  });

  test("invalidates on AST change: new reference after astOf.set with different AST", () => {
    const db = new Db();
    const ast1 = parse("x = 1\n");
    astOf.set(db, 0, ast1);
    const cfg1 = db.get(cfgOf, 0);

    const ast2 = parse("y = 2\n");
    astOf.set(db, 0, ast2);
    const cfg2 = db.get(cfgOf, 0);

    expect(cfg2).not.toBe(cfg1);
  });

  test("lattice-equal AST set is a no-op (no rebuild)", () => {
    const db = new Db();
    const ast = parse("x = 1\n");
    astOf.set(db, 0, ast);

    const { handle, getCount } = makeCountingCfgOf();
    db.get(handle, 0);
    expect(getCount()).toBe(1);

    astOf.set(db, 0, ast);
    db.get(handle, 0);
    expect(getCount()).toBe(1);
  });

  test("throws on missing AST", () => {
    const db = new Db();
    expect(() => db.get(cfgOf, 0)).toThrow(/no AST set/);
  });
});
