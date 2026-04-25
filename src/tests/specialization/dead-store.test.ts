import { ExprNS, StmtNS } from "../../ast-types";
import { setupAndDrain } from "./harness/compile-pipelines";

// Dead-store elimination: after convergence, pure assignments whose target is
// not live downstream are spliced from the AST. DSE only fires on
// function-scope locals — module-top-level assignments are part of the
// observable namespace and are intentionally preserved.

function optimiseFn(fnBody: string): StmtNS.Stmt[] {
  const indented = fnBody.split("\n").map(l => "    " + l).join("\n");
  const { ast, worklist } = setupAndDrain(`def f():\n${indented}`);
  const fnDef = worklist.functions.get(ast.id)!.body[0] as StmtNS.FunctionDef;
  return fnDef.body;
}

describe("dead-store elimination", () => {
  test("dead literal assign is removed from function body", () => {
    const stmts = optimiseFn(`x = 1\nreturn 2`);
    expect(stmts).toHaveLength(1);
    expect(stmts[0]).toBeInstanceOf(StmtNS.Return);
  });

  test("overwritten-before-read dead store is removed", () => {
    const stmts = optimiseFn(`x = 1\nx = 2\nreturn x`);
    expect(stmts).toHaveLength(2);
    const lit = (stmts[0] as StmtNS.Assign).value as ExprNS.Literal;
    expect(lit.value).toBe("2");
    expect(stmts[1]).toBeInstanceOf(StmtNS.Return);
  });

  test("live assign is preserved", () => {
    const stmts = optimiseFn(`x = 1\nreturn x`);
    expect(stmts).toHaveLength(2);
  });

  test("impure RHS preserved even when target is dead", () => {
    const stmts = optimiseFn(`x = input()\nreturn 0`);
    expect(stmts).toHaveLength(2);
    expect(stmts[0]).toBeInstanceOf(StmtNS.Assign);
  });

  test("gate pattern: dead-after-const-fold chain collapses fully", () => {
    const stmts = optimiseFn(
      [
        "seed = 7",
        "a = seed - seed",
        "b = seed // seed",
        "if a < b:",
        "    return 1",
        "else:",
        "    return 2",
      ].join("\n"),
    );
    expect(stmts).toHaveLength(1);
    const ret = stmts[0] as StmtNS.Return;
    expect((ret.value as ExprNS.Literal).value).toBe("1");
  });

  test("captured local NOT removed: lambda body reads it", () => {
    const stmts = optimiseFn(`x = 1\nf = lambda: x\nreturn f`);
    expect(stmts.filter(s => s instanceof StmtNS.Assign)).toHaveLength(2);
  });

  test("module-top-level assignments are NOT removed (observable namespace)", () => {
    const { ast, worklist } = setupAndDrain(`x = 1\ny = 2`);
    const stmts = worklist.functions.get(ast.id)!.body;
    expect(stmts.filter(s => s instanceof StmtNS.Assign)).toHaveLength(2);
  });
});
