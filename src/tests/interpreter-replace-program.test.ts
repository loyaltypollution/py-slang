import { parse } from "../parser/parser-adapter";
import { analyzeWithEnvironments } from "../resolver";
import { SVMLCompiler } from "../engines/svml/svml-compiler";
import { SVMLInterpreter } from "../engines/svml/svml-interpreter";
import { buildTestWorklist } from "./utils";

// ── Helpers ─────────────────────────────────────────────────────────────────

function compileAndRun(code: string): unknown {
  const ast = parse(code);
  const compiler = SVMLCompiler.fromProgram(ast);
  const program = compiler.compileProgram(ast);
  const interpreter = new SVMLInterpreter(program);
  return SVMLInterpreter.toJSValue(interpreter.execute());
}

function compileWithOptimization(code: string) {
  const script = code + "\n";
  const ast = parse(script);
  const { environments } = analyzeWithEnvironments(ast, script, 4);
  const engine = buildTestWorklist(ast, environments);
  engine.converge();
  const compiler = SVMLCompiler.fromProgramUnit(ast, environments, engine.units, engine.factStore);
  const program = compiler.compileProgram(ast);
  return { ast, environments, compiler, program };
}

function compileWithReactive(code: string) {
  const script = code + "\n";
  const ast = parse(script);
  const { environments } = analyzeWithEnvironments(ast, script, 4);
  const reactive = buildTestWorklist(ast, environments);
  reactive.converge();
  const compiler = SVMLCompiler.fromProgramUnit(ast, environments, reactive.units, reactive.factStore);
  const program = compiler.compileProgram(ast);
  return { ast, environments, reactive, compiler, program };
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe("SVMLInterpreter.replaceProgram", () => {
  test("replaceProgram between executions changes behavior", () => {
    // Compile two different programs
    const { program: programA } = compileWithOptimization("1 + 2");
    const { program: programB } = compileWithOptimization("10 + 20");

    const interpreter = new SVMLInterpreter(programA);
    const resultA = SVMLInterpreter.toJSValue(interpreter.execute());
    expect(resultA).toBe(3);

    // Replace and re-execute — interpreter should reflect new program
    interpreter.replaceProgram(programB);
    const resultB = SVMLInterpreter.toJSValue(interpreter.execute());
    expect(resultB).toBe(30);
  });

  test("replaceProgram works after construction (before first execute)", () => {
    const { program: programA } = compileWithOptimization("42");
    const { program: programB } = compileWithOptimization("99");

    const interpreter = new SVMLInterpreter(programA);
    // Replace before ever calling execute
    interpreter.replaceProgram(programB);
    const result = SVMLInterpreter.toJSValue(interpreter.execute());
    expect(result).toBe(99);
  });

  test("replaceProgram works after execution completes (currentFrame is null)", () => {
    const { program: programA } = compileWithOptimization("1");
    const interpreter = new SVMLInterpreter(programA);
    interpreter.execute();

    // After execution, currentFrame should be null — replaceProgram should not throw
    const { program: programB } = compileWithOptimization("2");
    expect(() => interpreter.replaceProgram(programB)).not.toThrow();
  });

  test("withSpecializedFunction produces correct differential update", () => {
    // Compile a program with a function, then replace one function's IR
    const code = `
def f():
    return 1

f()
`;
    const { program } = compileWithOptimization(code);
    const resultBefore = SVMLInterpreter.toJSValue(new SVMLInterpreter(program).execute());
    expect(resultBefore).toBe(1);

    // Compile a variant and splice its function IR into the original program
    const code2 = `
def f():
    return 2

f()
`;
    const { program: program2 } = compileWithOptimization(code2);

    // Both programs should have function at index 1 (entry is 0, f is 1)
    // Find the non-entry function index
    const fIdx = program.entryPoint === 0 ? 1 : 0;
    const patched = program.withSpecializedFunction(fIdx, program2.functions[fIdx]);

    const resultAfter = SVMLInterpreter.toJSValue(new SVMLInterpreter(patched).execute());
    expect(resultAfter).toBe(2);
  });
});

describe("PySvmlJitEvaluator differential correctness", () => {
  // These tests verify that the reactive optimization path produces the same
  // results as the standard optimization path.

  const cases: [string, string, unknown][] = [
    [
      "dead branch elimination (True branch)",
      `if True:
    x = 1
else:
    x = 2
x`,
      1,
    ],
    [
      "dead branch elimination (False branch)",
      `if False:
    x = 10
else:
    x = 20
x`,
      20,
    ],
    [
      "constant folding in function",
      `def f():
    return 2 + 3
f()`,
      5,
    ],
    [
      "nested conditionals",
      `def classify(n):
    if n > 0:
        return 1
    else:
        return -1
classify(5)`,
      1,
    ],
    [
      "loop with accumulation",
      `total = 0
for i in range(5):
    total = total + i
total`,
      10,
    ],
  ];

  test.each(cases)("%s: reactive path matches standard path", (_name, code, expected) => {
    // Standard path
    const standardResult = compileAndRun(code + "\n");
    expect(standardResult).toBe(expected);

    // Reactive path
    const { program } = compileWithReactive(code);
    const reactiveResult = SVMLInterpreter.toJSValue(new SVMLInterpreter(program).execute());
    expect(reactiveResult).toBe(expected);

    // Both should agree
    expect(reactiveResult).toEqual(standardResult);
  });

  test("reactive path with output matches standard path", () => {
    const code = 'print("hello")\n';

    // Standard path
    const stdOutputs: string[] = [];
    const ast1 = parse(code);
    const prog1 = SVMLCompiler.fromProgram(ast1).compileProgram(ast1);
    new SVMLInterpreter(prog1, { sendOutput: msg => stdOutputs.push(msg) }).execute();

    // Reactive path
    const reactiveOutputs: string[] = [];
    const { program } = compileWithReactive('print("hello")');
    new SVMLInterpreter(program, { sendOutput: msg => reactiveOutputs.push(msg) }).execute();

    expect(reactiveOutputs).toEqual(stdOutputs);
  });
});

describe("ScopeIndexMap wiring", () => {
  test("fromProgramUnit populates scopeIndexMap", () => {
    const code = `
def f(x):
    return x + 1
def g(y):
    return y * 2
f(1) + g(2)
`;
    const { compiler } = compileWithOptimization(code);
    const scopeMap = compiler.scopeIndexMap;

    // fromProgramUnit should have created a ScopeIndexMap
    expect(scopeMap).toBeDefined();
    // At least 3 entries: FileInput + f + g
    expect(scopeMap!.size).toBeGreaterThanOrEqual(3);
  });

  test("fromProgram does not create scopeIndexMap", () => {
    const ast = parse("1 + 2\n");
    const compiler = SVMLCompiler.fromProgram(ast);
    expect(compiler.scopeIndexMap).toBeUndefined();
  });
});
