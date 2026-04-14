import { ExprNS, StmtNS } from "../../../ast-types";
import { parse } from "../../../parser/parser-adapter";
import { analyzeWithEnvironments } from "../../../resolver";
import OpCodes from "../../../engines/svml/opcodes";
import { constAnalysisPass } from "../../../specialization/framework/dfa-passes";
import { readExprFact } from "../../../specialization/framework/dfa-factory";
import { buildTestWorklist } from "../../utils";
import { runSpecCase } from "../../harness/spec-e2e";

// Constant folding eliminates the arithmetic entirely. The only observable
// contract: neither the generic nor the specialized opcode appears in the
// compiled output. CPython prints the same value.
describe("const fold: expression elided from bytecode", () => {
  const rows: Array<[string, string, OpCodes, OpCodes]> = [
    ["3 + 4 = 7", "print(3 + 4)", OpCodes.ADDG, OpCodes.ADDF],
    ["3 * 4 = 12", "print(3 * 4)", OpCodes.MULG, OpCodes.MULF],
    ["3 < 4", "print(3 < 4)", OpCodes.LTG, OpCodes.LTF],
    ["10 - 3 = 7", "print(10 - 3)", OpCodes.SUBG, OpCodes.SUBF],
    ["7 // 2 = 3", "print(7 // 2)", OpCodes.FLOORDIVG, OpCodes.FLOORDIVF],
  ];

  test.each(rows)("%s: operation folded", (label, code, generic, specialized) => {
    runSpecCase(label, {
      code,
      cpython: code,
      checks: [
        { kind: "absent", opcode: generic },
        { kind: "absent", opcode: specialized },
      ],
    });
  });
});

// Dead-branch elimination follows const fold on the predicate.
describe("const fold: dead branch erases comparison and BRF", () => {
  test("const vars through comparison: no GT, no BRF", () => {
    const code = `
x = 3
y = 4
if x > y:
    print(1)
else:
    print(2)
`;
    runSpecCase("const-vars-branch", {
      code,
      cpython: code,
      checks: [
        { kind: "absent", opcode: OpCodes.GTG },
        { kind: "absent", opcode: OpCodes.GTF },
        { kind: "absent", opcode: OpCodes.BRF },
      ],
    });
  });
});

// Hint-store population is a precondition for downstream transforms and for
// the CSE stepper to surface constants. Assertions live at the fact level
// rather than bytecode because the hint is what transforms consume.
describe("const fold: factStore carries constVal", () => {
  function analyse(code: string) {
    const script = code + "\n";
    const ast = parse(script) as StmtNS.FileInput;
    const { environments } = analyzeWithEnvironments(ast, script, 4);
    const reactive = buildTestWorklist(ast, environments);
    reactive.drain();
    return { ast, reactive };
  }

  test("x = 3 + 4: RHS fact is const(7)", () => {
    const { ast, reactive } = analyse("x = 3 + 4");
    const assign = ast.statements[0] as StmtNS.Assign;
    const cv = readExprFact(
      reactive.factStore,
      constAnalysisPass,
      reactive.blockOfNode(assign.value.id),
      assign.value.id,
    );
    expect(cv?.tag).toBe("const");
    expect((cv as { value: unknown }).value).toBe(7);
  });

  test("variable propagation: y = x + 2 has const(7)", () => {
    const { ast, reactive } = analyse("x = 5\ny = x + 2");
    const assign = ast.statements[1] as StmtNS.Assign;
    const cv = readExprFact(
      reactive.factStore,
      constAnalysisPass,
      reactive.blockOfNode(assign.value.id),
      assign.value.id,
    );
    expect(cv?.tag).toBe("const");
    expect((cv as { value: unknown }).value).toBe(7);
  });

  test("nested folds: 1 + 2 + 3 resolves to const(6) at root", () => {
    const { ast, reactive } = analyse("x = 1 + 2 + 3");
    const assign = ast.statements[0] as StmtNS.Assign;
    // After folding, the Assign's value is a Literal(6) — but if folding
    // ran node-local, the root binop is also const(6).
    const rhs = assign.value;
    if (rhs instanceof ExprNS.Literal) {
      expect(rhs.value).toBe(6);
    } else {
      const cv = readExprFact(
        reactive.factStore,
        constAnalysisPass,
        reactive.blockOfNode(rhs.id),
        rhs.id,
      );
      expect(cv?.tag).toBe("const");
      expect((cv as { value: unknown }).value).toBe(6);
    }
  });
});
