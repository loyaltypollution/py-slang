// src/tests/runtime/lowering.test.ts — Phase 4 lowering-chain spec tests.

import { ExprNS, StmtNS } from "../../ast-types";
import { parse } from "../../parser/parser-adapter";
import { Resolver } from "../../resolver";
import { MEMOIZATION_THRESHOLD } from "../../specialization/memoization-analysis/call-count";
import {
  Db,
  astAfterConstFold,
  astAfterDeadBranch,
  astAfterMemoize,
  astOf,
  environmentsOf,
  optimizedAstOf,
  runtimeCall,
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

describe("runtime/queries/lowering", () => {
  test("identity through chain when no rewrite fires", () => {
    const { db, ast } = setupUnit("x = 1\nprint(x)");
    const opt = db.get(optimizedAstOf, 0);
    expect(opt).toBe(ast);
    expect(db.get(astAfterDeadBranch, 0)).toBe(ast);
    expect(db.get(astAfterConstFold, 0)).toBe(ast);
    expect(db.get(astAfterMemoize, 0)).toBe(ast);
  });

  test("dead branch: `if False` keeps only the else body", () => {
    const { db, ast } = setupUnit(["if False:", "    x = 1", "else:", "    x = 2"].join("\n"));
    const after = db.get(astAfterDeadBranch, 0);
    expect(after).not.toBe(ast);
    if (after === undefined) throw new Error("unreachable");
    // Original had a single If statement; after removal we should have the
    // else body (one Assign with rhs 2) and nothing else.
    expect(after.statements.length).toBe(1);
    expect(after.statements[0]).toBeInstanceOf(StmtNS.Assign);
    const opt = db.get(optimizedAstOf, 0);
    expect(opt).toBe(after); // propagated through const-fold + memoize untouched
  });

  test("constant folding: `2 + 3` becomes literal 5", () => {
    const { db, ast } = setupUnit("x = 2 + 3");
    const after = db.get(astAfterConstFold, 0);
    expect(after).not.toBe(ast);
    if (after === undefined) throw new Error("unreachable");
    const assign = after.statements[0] as StmtNS.Assign;
    expect(assign.value).toBeInstanceOf(ExprNS.Literal);
    expect((assign.value as ExprNS.Literal).value).toBe(5);
  });

  test("memoize wraps recursive fib body when runtimeCall hits threshold", () => {
    const { db, ast } = setupUnit(
      [
        "def fib(n):",
        "    return n if n < 2 else fib(n - 1) + fib(n - 2)",
      ].join("\n"),
    );
    const fibId = findFunctionId(ast, "fib");
    runtimeCall.set(db, fibId, MEMOIZATION_THRESHOLD);

    const after = db.get(astAfterMemoize, 0);
    expect(after).not.toBe(ast);
    if (after === undefined) throw new Error("unreachable");
    const fd = after.statements[0] as StmtNS.FunctionDef;
    expect(fd).toBeInstanceOf(StmtNS.FunctionDef);
    // Wrapped body starts with a memoization prelude: an If.
    expect(fd.body[0]).toBeInstanceOf(StmtNS.If);
  });

  test("no memoize when below threshold: identity", () => {
    const { db, ast } = setupUnit(
      [
        "def fib(n):",
        "    return n if n < 2 else fib(n - 1) + fib(n - 2)",
      ].join("\n"),
    );
    const fibId = findFunctionId(ast, "fib");
    runtimeCall.set(db, fibId, MEMOIZATION_THRESHOLD - 1);
    const after = db.get(astAfterMemoize, 0);
    expect(after).toBe(ast);
  });

  test("structural sharing: unchanged stmts keep identity after dead-branch", () => {
    const { db, ast } = setupUnit(
      ["x = 1", "if False:", "    y = 2", "z = 3"].join("\n"),
    );
    const xAssign = ast.statements[0];
    const zAssign = ast.statements[2];
    const after = db.get(astAfterDeadBranch, 0);
    if (after === undefined) throw new Error("unreachable");
    // Post-elimination: [x=1, z=3]. Both statement nodes must be the same refs.
    expect(after.statements[0]).toBe(xAssign);
    expect(after.statements[1]).toBe(zAssign);
  });

  test("early cutoff: post-threshold runtimeCall bumps do not recompute optimizedAstOf", () => {
    const { db, ast } = setupUnit(
      [
        "def fib(n):",
        "    return n if n < 2 else fib(n - 1) + fib(n - 2)",
      ].join("\n"),
    );
    const fibId = findFunctionId(ast, "fib");
    runtimeCall.set(db, fibId, MEMOIZATION_THRESHOLD);
    const first = db.get(optimizedAstOf, 0);
    // Re-read without mutation → same reference.
    expect(db.get(optimizedAstOf, 0)).toBe(first);
    // Bumping runtimeCall past saturation must not produce a new AST: the
    // input's saturating lattice snaps equal, `callCountOf` stays at
    // THRESHOLD, `shouldMemoize` stays true, `astAfterMemoize` stays green.
    runtimeCall.set(db, fibId, MEMOIZATION_THRESHOLD + 5);
    expect(db.get(optimizedAstOf, 0)).toBe(first);
    runtimeCall.set(db, fibId, MEMOIZATION_THRESHOLD + 100);
    expect(db.get(optimizedAstOf, 0)).toBe(first);
  });
});
