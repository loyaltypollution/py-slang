// Diagnostic test: verify that guard narrowing actually reaches the SVML
// specializer, picking F-opcodes for arithmetic inside a narrowed branch.

import { StmtNS } from "../../../ast-types";
import OpCodes from "../../../engines/svml/opcodes";
import { parse } from "../../../parser/parser-adapter";
import { analyzeWithEnvironments } from "../../../resolver";
import { typeAnalysisPass } from "../../../specialization/framework/dfa-passes";
import { readExprFact } from "../../../specialization/framework/dfa-factory";
import { BOOL_BIT, FLOAT_BIT, INT_BIT, IntRef } from "../../../specialization/type-analysis/lattice";
import { compileOptimized } from "../../harness/compile-pipelines";
import { hasOpcode } from "../../harness/opcode-assert";
import { buildTestWorklist } from "../../utils";

function analyse(code: string) {
  const script = code + "\n";
  const ast = parse(script) as StmtNS.FileInput;
  const { environments } = analyzeWithEnvironments(ast, script, 4);
  const reactive = buildTestWorklist(ast, environments);
  reactive.drain();
  return { ast, reactive };
}

describe("narrow → specialize: fact store", () => {
  test("`x > 0` narrows `x` inside true branch to INT_POS", () => {
    const code = `
def f(x):
    if x > 0:
        y = x * 2
        return y
    return 0
`;
    const { ast, reactive } = analyse(code);
    const fn = ast.statements[0] as StmtNS.FunctionDef;
    // Walk to find the `x` Variable node inside `x * 2`.
    const ifStmt = fn.body[0] as StmtNS.If;
    const assign = ifStmt.body[0] as StmtNS.Assign;
    // assign.value is `x * 2` as a Binary
    const bin = assign.value as import("../../../ast-types").ExprNS.Binary;
    const xNode = bin.left; // Variable x
    const t = readExprFact(
      reactive.factStore,
      typeAnalysisPass,
      reactive.blockOfNode(xNode.id),
      xNode.id,
    );
    // Narrowing produces the mixed numeric kind INT|FLOAT|BOOL with Pos in
    // both sign fields — `x > 0` does not distinguish int/float/bool, only
    // sign. BOOL is included because Python `bool <: int` (True > 0 holds).
    expect(t?.kinds).toBe(INT_BIT | FLOAT_BIT | BOOL_BIT);
    expect(t?.intRef).toBe(IntRef.Pos);
    expect(t?.floatRef).toBe(IntRef.Pos);
  });
});

describe("narrow → specialize: emitted opcodes", () => {
  test("`x * 2` inside `if x > 0:` emits MULF (specialized)", () => {
    const code = `
def f(x):
    if x > 0:
        return x * 2
    return 0
print(f(5))
`;
    const opt = compileOptimized(code);
    expect(hasOpcode(opt, OpCodes.MULF)).toBe(true);
    expect(hasOpcode(opt, OpCodes.MULG)).toBe(false);
  });
});
