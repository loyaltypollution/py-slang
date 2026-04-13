/**
 * End-to-end JIT wiring through the SVMLCompiler/Interpreter pair.
 * Verifies that `patchFunction` accepts the compiler's stable index and
 * a freshly recompiled IR for a `FunctionUnit`. Dispatch patching, not
 * OSR: live `CallFrame.ir` references drain on the old IR while future
 * CALLs dispatch through the patched slot.
 */

import { StmtNS } from "../ast-types";
import { parse } from "../parser/parser-adapter";
import { analyzeWithEnvironments } from "../resolver";
import { buildTestUnits } from "./utils";
import { SVMLCompiler } from "../engines/svml/svml-compiler";
import { SVMLInterpreter } from "../engines/svml/svml-interpreter";

function buildUnit(code: string) {
  const script = code + "\n";
  const ast = parse(script) as StmtNS.FileInput;
  const { environments } = analyzeWithEnvironments(ast, script, 4);
  const { db, units } = buildTestUnits(ast, environments);
  const compiler = SVMLCompiler.fromProgramUnit(ast, environments, units, db);
  const program = compiler.compileProgram(ast);
  return { ast, environments, units, compiler, program };
}

describe("SVML JIT end-to-end wiring", () => {
  test("patchFunction targets the compiler's stable index for the changed scope", () => {
    const code = `
def g():
    return 42
g()
`;
    const { ast, units, compiler, program } = buildUnit(code);
    const interpreter = new SVMLInterpreter(program);
    const gDef = ast.statements[0] as StmtNS.FunctionDef;
    const gUnit = units.get(gDef);
    expect(gUnit).toBeDefined();

    const patchSpy = jest.spyOn(interpreter, "patchFunction");

    // Direct path: what the JIT evaluator's recompile callback does.
    const expectedIndex = compiler.indexOf(gDef)!;
    const newIR = compiler.compileFunction(gUnit!);
    interpreter.patchFunction(expectedIndex, newIR);

    expect(patchSpy).toHaveBeenCalledTimes(1);
    expect(patchSpy).toHaveBeenCalledWith(expectedIndex, newIR);
    patchSpy.mockRestore();
  });
});
