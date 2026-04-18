import { ExprNS, StmtNS } from "../../../ast-types";
import { parse } from "../../../parser/parser-adapter";
import { analyzeWithEnvironments } from "../../../resolver";
import { Worklist } from "../../../specialization/framework/worklist";

// Dead-store elimination: after convergence, pure assignments whose target is
// not live downstream are spliced from the AST. Drives the "gate collapse"
// demo: once const-fold + dead-branch eliminate the consumer, DSE removes
// the assignment itself.
//
// DSE only fires on function-scope locals. Module-top-level assignments are
// part of the observable namespace and are intentionally preserved. These
// tests wrap bodies in `def f(): ...` so the transform actually runs.

function optimiseFn(fnBody: string): StmtNS.Stmt[] {
  const script = `def f():\n${fnBody.split("\n").map(l => "    " + l).join("\n")}\n`;
  const ast = parse(script) as StmtNS.FileInput;
  const { environments } = analyzeWithEnvironments(ast, script, 4);
  const reactive = new Worklist(ast, environments);
  reactive.drain();
  const fnDef = reactive.units.get(ast)!.body[0] as StmtNS.FunctionDef;
  return fnDef.body;
}

describe("dead-store elimination", () => {
  test("dead literal assign is removed from function body", () => {
    const stmts = optimiseFn(`x = 1\nreturn 2`);
    // `x = 1` removed; only the return remains.
    expect(stmts).toHaveLength(1);
    expect(stmts[0]).toBeInstanceOf(StmtNS.Return);
  });

  test("overwritten-before-read dead store is removed", () => {
    const stmts = optimiseFn(`x = 1\nx = 2\nreturn x`);
    // First `x = 1` is dead (overwritten); second stays (read by return).
    expect(stmts).toHaveLength(2);
    const first = stmts[0] as StmtNS.Assign;
    const lit = first.value as ExprNS.Literal;
    expect(lit.value).toBe("2");
    expect(stmts[1]).toBeInstanceOf(StmtNS.Return);
  });

  test("live assign is preserved", () => {
    const stmts = optimiseFn(`x = 1\nreturn x`);
    expect(stmts).toHaveLength(2);
    expect(stmts[0]).toBeInstanceOf(StmtNS.Assign);
    expect(stmts[1]).toBeInstanceOf(StmtNS.Return);
  });

  test("impure RHS preserved even when target is dead", () => {
    const stmts = optimiseFn(`x = input()\nreturn 0`);
    // input() is impure (Call). Must stay despite x dead.
    expect(stmts).toHaveLength(2);
    expect(stmts[0]).toBeInstanceOf(StmtNS.Assign);
  });

  test("gate pattern: dead-after-const-fold chain collapses fully", () => {
    const stmts = optimiseFn(
      [
        "seed = 7",
        "a = seed - seed",      // → 0
        "b = seed // seed",     // → 1
        "if a < b:",            // → True (0 < 1)
        "    return 1",
        "else:",
        "    return 2",
      ].join("\n"),
    );
    // After the pipeline: no assignments left (all folded + dead), only the
    // taken `return 1`. The `else` arm is gone via dead-branch; `seed`, `a`,
    // `b` all dead after that, DSE sweeps them.
    const hasAssigns = stmts.some(s => s instanceof StmtNS.Assign);
    expect(hasAssigns).toBe(false);
    expect(stmts).toHaveLength(1);
    expect(stmts[0]).toBeInstanceOf(StmtNS.Return);
    const ret = stmts[0] as StmtNS.Return;
    expect((ret.value as ExprNS.Literal).value).toBe("1");
  });

  test("captured local NOT removed: lambda body reads it", () => {
    // x is only "read" via the lambda body; a liveness pass that doesn't
    // walk lambda bodies would see x as dead. DSE must treat it as live.
    const stmts = optimiseFn(`x = 1\nf = lambda: x\nreturn f`);
    const assigns = stmts.filter(s => s instanceof StmtNS.Assign);
    // Both `x = 1` and `f = lambda: x` preserved.
    expect(assigns).toHaveLength(2);
  });

  test("module-top-level assignments are NOT removed (observable namespace)", () => {
    const script = `x = 1\ny = 2\n`;
    const ast = parse(script) as StmtNS.FileInput;
    const { environments } = analyzeWithEnvironments(ast, script, 4);
    const reactive = new Worklist(ast, environments);
    reactive.drain();
    const stmts = reactive.units.get(ast)!.body;
    // Both assignments preserved — module globals are observable.
    expect(stmts.filter(s => s instanceof StmtNS.Assign)).toHaveLength(2);
  });
});
