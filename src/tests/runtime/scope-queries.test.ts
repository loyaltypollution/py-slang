// src/tests/runtime/scope-queries.test.ts — Phase 3e spec tests

import { StmtNS } from "../../ast-types";
import { parse } from "../../parser/parser-adapter";
import { Resolver } from "../../resolver";
import { MEMOIZATION_THRESHOLD } from "../../specialization/memoization-analysis/call-count";
import {
  Db,
  astOf,
  callCountOf,
  environmentsOf,
  purityOf,
  runtimeCall,
  shouldMemoize,
  defineQuery,
  type Lattice,
} from "../../specialization/runtime";
import { makeValidatorsForChapter } from "../../validator";

function setupUnit(code: string): { db: Db; ast: StmtNS.FileInput } {
  const script = code.endsWith("\n") ? code : code + "\n";
  const ast = parse(script);
  const resolver = new Resolver(script, ast, makeValidatorsForChapter(4));
  const errors = resolver.resolve(ast);
  if (errors.length > 0) throw errors[0];

  const db = new Db();
  astOf.set(db, 0, ast);
  environmentsOf.set(db, 0, resolver.functionEnvironments);
  return { db, ast };
}

function findFunctionId(ast: StmtNS.FileInput, name: string): number {
  for (const stmt of ast.statements) {
    if (stmt instanceof StmtNS.FunctionDef && stmt.name.lexeme === name) {
      return stmt.id;
    }
  }
  throw new Error(`FunctionDef ${name} not found`);
}

describe("runtime/queries/callCountOf", () => {
  test("saturates at MEMOIZATION_THRESHOLD", () => {
    const { db } = setupUnit("x = 1");
    const scope = 1;

    const samples = [1, 5, MEMOIZATION_THRESHOLD - 1, MEMOIZATION_THRESHOLD, MEMOIZATION_THRESHOLD + 10];
    for (const n of samples) {
      runtimeCall.set(db, scope, n);
      const got = db.get(callCountOf, scope);
      expect(got).toBe(Math.min(n, MEMOIZATION_THRESHOLD));
    }
  });

  test("early cutoff: no dependent recompute once saturated", () => {
    const { db } = setupUnit("x = 1");
    const scope = 2;

    // Wrapper query that counts invocations of its fn. Depends on
    // callCountOf so it recomputes iff the upstream cell's value changes.
    let ticks = 0;
    const countingLattice: Lattice<number> = {
      bottom: -1,
      equals: (a, b) => a === b,
      join: Math.max,
    };
    const wrapper = defineQuery<number, number>({
      name: "scopeTestWrapper",
      lattice: countingLattice,
      serialize: String,
      fn: (d, k) => {
        ticks++;
        return d.get(callCountOf, k);
      },
    });

    runtimeCall.set(db, scope, MEMOIZATION_THRESHOLD);
    db.get(wrapper, scope);
    const afterSaturation = ticks;

    // Post-saturation writes are lattice-equal at the input layer, so
    // neither callCountOf nor wrapper should recompute.
    runtimeCall.set(db, scope, MEMOIZATION_THRESHOLD + 1);
    db.get(wrapper, scope);
    runtimeCall.set(db, scope, MEMOIZATION_THRESHOLD + 100);
    db.get(wrapper, scope);

    expect(ticks).toBe(afterSaturation);
  });
});

describe("runtime/queries/purityOf", () => {
  test("pure function: def f(): return 1", () => {
    const { db, ast } = setupUnit("def f():\n    return 1");
    const id = findFunctionId(ast, "f");
    expect(db.get(purityOf, id)).toBe("pure");
  });

  test("impure function: writes to outer binding", () => {
    // `g = 0` is a top-level binding; reassigning it inside `f` requires a
    // `global` declaration, and even the nonlocal read in the RHS flags
    // the function as impure per migrated-passes semantics.
    const { db, ast } = setupUnit([
      "g = 0",
      "def f():",
      "    global g",
      "    g = 1",
    ].join("\n"));
    const id = findFunctionId(ast, "f");
    expect(db.get(purityOf, id)).toBe("impure");
  });
});

describe("runtime/queries/shouldMemoize", () => {
  test("fires when (count >= threshold AND pure)", () => {
    const { db, ast } = setupUnit("def f():\n    return 1");
    const id = findFunctionId(ast, "f");

    runtimeCall.set(db, id, MEMOIZATION_THRESHOLD);
    expect(db.get(shouldMemoize, id)).toBe(true);
  });

  test("cuts off after firing: further increments don't invalidate", () => {
    const { db, ast } = setupUnit("def f():\n    return 1");
    const id = findFunctionId(ast, "f");

    let ticks = 0;
    const countingLattice: Lattice<boolean> = {
      bottom: false,
      equals: (a, b) => a === b,
      join: (a, b) => a || b,
    };
    const wrapper = defineQuery<number, boolean>({
      name: "shouldMemoizeTestWrapper",
      lattice: countingLattice,
      serialize: String,
      fn: (d, k) => {
        ticks++;
        return d.get(shouldMemoize, k);
      },
    });

    runtimeCall.set(db, id, MEMOIZATION_THRESHOLD);
    expect(db.get(wrapper, id)).toBe(true);
    const baseline = ticks;

    runtimeCall.set(db, id, MEMOIZATION_THRESHOLD + 5);
    db.get(wrapper, id);
    runtimeCall.set(db, id, MEMOIZATION_THRESHOLD + 20);
    db.get(wrapper, id);
    expect(ticks).toBe(baseline);
  });

  test("does NOT fire for impure scope, even with high callCount", () => {
    const { db, ast } = setupUnit([
      "g = 0",
      "def f():",
      "    global g",
      "    g = 1",
    ].join("\n"));
    const id = findFunctionId(ast, "f");

    runtimeCall.set(db, id, MEMOIZATION_THRESHOLD * 5);
    expect(db.get(shouldMemoize, id)).toBe(false);
  });
});
