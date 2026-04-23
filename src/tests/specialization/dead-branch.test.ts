import { ExprNS, StmtNS } from "../../ast-types";
import OpCodes from "../../engines/svml/opcodes";
import { setupAndDrain } from "./harness/compile-pipelines";
import { runSpecCase } from "./harness/spec-e2e";

// Dead-branch elimination: after convergence, the eliminated arm's bytecode
// is gone. Asserted through absence of BRF plus AST-shape checks that catch
// regressions where the analysis runs but produces a valid-but-unpruned tree.

function optimise(code: string): StmtNS.Stmt[] {
  const { ast, worklist } = setupAndDrain(code);
  return worklist.units.get(ast.id)!.body;
}

describe("dead-branch elimination", () => {
  test("if True collapses to then-body", () => {
    const stmts = optimise("if True:\n  x = 1\nelse:\n  x = 2");
    expect(stmts).toHaveLength(1);
    const lit = (stmts[0] as StmtNS.Assign).value as ExprNS.Literal;
    expect(lit.value).toBe("1");

    runSpecCase("if-true", {
      code: "if True:\n  x = 1\nelse:\n  x = 2\nprint(x)",
      checks: [{ kind: "absent", opcode: OpCodes.BRF }],
    });
  });

  test("if False collapses to else-body", () => {
    const stmts = optimise("if False:\n  x = 1\nelse:\n  x = 2");
    expect(stmts).toHaveLength(1);
    const lit = (stmts[0] as StmtNS.Assign).value as ExprNS.Literal;
    expect(lit.value).toBe("2");

    runSpecCase("if-false", {
      code: "if False:\n  x = 1\nelse:\n  x = 2\nprint(x)",
      checks: [{ kind: "absent", opcode: OpCodes.BRF }],
    });
  });

  test("if False without else: statement deleted entirely", () => {
    expect(optimise("if False:\n  x = 1")).toHaveLength(0);
  });
});
