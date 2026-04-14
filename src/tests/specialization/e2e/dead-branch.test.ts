import { ExprNS, StmtNS } from "../../../ast-types";
import { parse } from "../../../parser/parser-adapter";
import { analyzeWithEnvironments } from "../../../resolver";
import OpCodes from "../../../engines/svml/opcodes";
import { structuralPass } from "../../../specialization/framework/structural-pass";
import { buildTestWorklist } from "../../utils";
import { runSpecCase } from "../../harness/spec-e2e";

// Dead-branch elimination: after convergence, the predicate is known and the
// eliminated arm's bytecode is gone. Asserted through (a) CPython stdout
// parity, (b) absence of BRF in the compiled program. AST-shape assertions
// are preserved here because they catch a regression where the pass runs but
// produces a valid-but-unpruned tree.

function optimise(code: string): StmtNS.Stmt[] {
  const script = code + "\n";
  const ast = parse(script) as StmtNS.FileInput;
  const { environments } = analyzeWithEnvironments(ast, script, 4);
  const reactive = buildTestWorklist(ast, environments);
  reactive.drain();
  return reactive.units.get(ast)!.body;
}

describe("dead-branch elimination", () => {
  test("if True collapses to then-body", () => {
    const stmts = optimise("if True:\n  x = 1\nelse:\n  x = 2");
    expect(stmts).toHaveLength(1);
    const lit = (stmts[0] as StmtNS.Assign).value as ExprNS.Literal;
    expect(lit.value).toBe("1");

    runSpecCase("if-true", {
      code: "if True:\n  x = 1\nelse:\n  x = 2\nprint(x)",
      cpython: "if True:\n  x = 1\nelse:\n  x = 2\nprint(x)",
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
      cpython: "if False:\n  x = 1\nelse:\n  x = 2\nprint(x)",
      checks: [{ kind: "absent", opcode: OpCodes.BRF }],
    });
  });

  test("if False without else: statement deleted entirely", () => {
    const stmts = optimise("if False:\n  x = 1");
    expect(stmts).toHaveLength(0);
  });

  test("compound fold+dead-branch: x = 1 + 2 wins", () => {
    const stmts = optimise("if True:\n  x = 1 + 2\nelse:\n  x = 99");
    expect(stmts).toHaveLength(1);
    const lit = (stmts[0] as StmtNS.Assign).value as ExprNS.Literal;
    expect(lit.value).toBe(3);
  });
});

// Idempotence and versioning: the worklist reaches a stable state and
// records whether any structural rewrite happened.
describe("worklist stability", () => {
  test("no-transform code leaves structuralVersion at 0", () => {
    const script = "x = 1\ny = 2\n";
    const ast = parse(script) as StmtNS.FileInput;
    const { environments } = analyzeWithEnvironments(ast, script, 4);
    const reactive = buildTestWorklist(ast, environments);
    reactive.drain();
    for (const unit of reactive.units.values()) {
      expect(reactive.factStore.read(structuralPass, unit)).toBe(0);
    }
  });

  test("dead branch bumps structuralVersion > 0", () => {
    const script = "if True:\n  x = 1\nelse:\n  x = 2\n";
    const ast = parse(script) as StmtNS.FileInput;
    const { environments } = analyzeWithEnvironments(ast, script, 4);
    const reactive = buildTestWorklist(ast, environments);
    reactive.drain();
    expect(
      reactive.factStore.read(structuralPass, reactive.units.get(ast)!),
    ).toBeGreaterThan(0);
  });

  test("drain() size reports pending work", () => {
    const script = "x = 1 + 2\n";
    const ast = parse(script) as StmtNS.FileInput;
    const { environments } = analyzeWithEnvironments(ast, script, 4);
    const reactive = buildTestWorklist(ast, environments);
    expect(reactive.drain(100).size > 0).toBe(true);
    reactive.drain();
    expect(reactive.drain().size > 0).toBe(false);
  });
});
