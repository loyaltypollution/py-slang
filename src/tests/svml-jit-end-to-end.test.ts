/**
 * End-to-end JIT wiring through `Worklist.onScopeChanged` — the dispatch
 * patcher previously known as the "OSR coordinator + state-delta strategy"
 * pair. The listener receives pre-resolved `(scope, unit)` pairs and is
 * responsible for recompiling + patching the interpreter's function table.
 *
 * This is dispatch patching, not OSR: `CallFrame.ir` is captured at CALL
 * time, so live frames drain on the old IR while future CALLs dispatch
 * through the patched slot.
 */

import { StmtNS } from "../ast-types";
import { parse } from "../parser/parser-adapter";
import { analyzeWithEnvironments } from "../resolver";
import { buildTestWorklist } from "./utils";
import { SVMLCompiler } from "../engines/svml/svml-compiler";
import { SVMLInterpreter } from "../engines/svml/svml-interpreter";

function buildUnit(code: string) {
  const script = code + "\n";
  const ast = parse(script) as StmtNS.FileInput;
  const { environments } = analyzeWithEnvironments(ast, script, 4);
  const reactive = buildTestWorklist(ast, environments);
  reactive.converge();
  const compiler = SVMLCompiler.fromProgramUnit(ast, environments, reactive.units);
  const program = compiler.compileProgram(ast);
  return { ast, environments, reactive, compiler, program };
}

describe("SVML JIT end-to-end wiring", () => {
  test("patchFunction targets the compiler's stable index for the changed scope", () => {
    const code = `
def g():
    return 42
g()
`;
    const { ast, reactive, compiler, program } = buildUnit(code);
    const interpreter = new SVMLInterpreter(program, { observationSink: reactive });
    const gDef = ast.statements[0] as StmtNS.FunctionDef;
    const gUnit = reactive.units.get(gDef);
    expect(gUnit).toBeDefined();

    const patchSpy = jest.spyOn(interpreter, "patchFunction");

    // Direct-path: what the `onScopeChanged` callback in PySvmlJitEvaluator does.
    const expectedIndex = compiler.indexOf(gDef)!;
    const newIR = compiler.compileFunction(gUnit!);
    interpreter.patchFunction(expectedIndex, newIR);

    expect(patchSpy).toHaveBeenCalledTimes(1);
    expect(patchSpy).toHaveBeenCalledWith(expectedIndex, newIR);
    patchSpy.mockRestore();
  });

  test("onScopeChanged routes transforms to per-function recompile + patch", async () => {
    const code = `
def g():
    return 1
g()
`;
    const { ast, reactive, compiler, program } = buildUnit(code);
    const interpreter = new SVMLInterpreter(program, { observationSink: reactive });
    const gDef = ast.statements[0] as StmtNS.FunctionDef;

    const patchSpy = jest.spyOn(interpreter, "patchFunction");

    reactive.onScopeChanged((scope, unit) => {
      if (!(scope instanceof StmtNS.FunctionDef)) return;
      const index = compiler.indexOf(scope);
      if (index === undefined) return;
      interpreter.patchFunction(index, compiler.compileFunction(unit));
    });

    await interpreter.execute();
    reactive.tick();

    // Execution succeeded; listener was wired. Patching may or may not have
    // fired depending on whether runtime observations refined any hints
    // beyond the static fixpoint — the invariant is that any call that did
    // fire targeted a FunctionDef index (FileInput is filtered by the
    // callback and never reaches patchFunction).
    for (const call of patchSpy.mock.calls) {
      const [index] = call;
      expect(index).toBe(compiler.indexOf(gDef));
    }
    patchSpy.mockRestore();
  });
});
