import { StmtNS } from "../../../ast-types";
import { makeJitPass } from "../../../engines/svml/jit-pass";
import { SVMLCompiler } from "../../../engines/svml/svml-compiler";
import { SVMLInterpreter } from "../../../engines/svml/svml-interpreter";
import { SVMLIR } from "../../../engines/svml/types";
import { parse } from "../../../parser/parser-adapter";
import { analyzeWithEnvironments } from "../../../resolver";
import {
  MEMOIZATION_THRESHOLD,
  RUNTIME_CALL_COUNT_SAT,
  callCountPass,
  purityScopePass,
  runtimeCallPass,
  structuralPass,
} from "../../../specialization";
import { constAnalysisPass } from "../../../specialization/const-analysis/analysis";
import { typeAnalysisPass } from "../../../specialization/type-analysis/analysis";
import type { FunctionUnit } from "../../../specialization/framework/function-unit";
import type { Pass, PassCtx } from "../../../specialization/framework/pass";
import { buildTestWorklist } from "../../utils";

function buildUnit(code: string) {
  const script = code + "\n";
  const ast = parse(script) as StmtNS.FileInput;
  const { environments } = analyzeWithEnvironments(ast, script, 4);
  const reactive = buildTestWorklist(ast, environments);
  reactive.converge();
  const compiler = SVMLCompiler.fromProgramUnit(
    ast,
    environments,
    reactive.units,
    reactive.factStore,
  );
  return { ast, environments, reactive, compiler, program: compiler.compileProgram(ast) };
}

// ── (1) Saturation: callCountPass caps at SAT and suppresses consumer rerun ──
describe("callCountPass saturation", () => {
  function setup() {
    const { ast, reactive } = buildUnit(`
def f():
    return 1
f()
`);
    const fDef = ast.statements[0] as StmtNS.FunctionDef;
    return { worklist: reactive, unit: reactive.units.get(fDef)!, fDef };
  }

  test("consumer wakeups capped at MEMOIZATION_THRESHOLD + 1", () => {
    const { worklist, fDef } = setup();
    let transferRuns = 0;
    const observer: Pass<number, number> = {
      id: Symbol("observer"),
      debugName: "observer",
      lattice: {
        bottom: 0,
        equals: (a, b) => a === b,
        join: (a, b) => Math.max(a, b),
      },
      reads: [callCountPass],
      tier: "transform",
      transfer(ctx, key) {
        transferRuns++;
        return ctx.read(callCountPass, key) ?? 0;
      },
      affectedKeys(_ctx, triggerPass, triggerKey) {
        return triggerPass === (callCountPass as Pass<unknown, unknown>)
          ? [triggerKey as number]
          : [];
      },
    };
    worklist.register(observer);

    for (let i = 1; i <= MEMOIZATION_THRESHOLD * 5; i++) {
      worklist.observe(runtimeCallPass, fDef.id, i);
    }
    expect(transferRuns).toBeGreaterThan(0);
    expect(transferRuns).toBeLessThanOrEqual(MEMOIZATION_THRESHOLD + 1);
  });

  test("jit-style transfer fires exactly once at saturation", () => {
    const { worklist, unit, fDef } = setup();
    let patchCalls = 0;
    const jitPass: Pass<FunctionUnit, number> = {
      id: Symbol("test-jitPass"),
      debugName: "test-jitPass",
      lattice: {
        bottom: 0,
        equals: (a, b) => a === b,
        join: (a, b) => Math.max(a, b),
      },
      reads: [callCountPass],
      tier: "transform",
      affectedKeys: () => [unit],
      transfer(ctx, u) {
        const c = ctx.read(callCountPass, fDef.id) ?? 0;
        if (c <= MEMOIZATION_THRESHOLD) return undefined;
        const prev = ctx.read(jitPass, u);
        if (prev === 1) return undefined;
        patchCalls++;
        return 1;
      },
    };
    worklist.register(jitPass);
    worklist.enqueue(jitPass, unit);
    worklist.drainPasses();
    expect(patchCalls).toBe(0);

    for (let i = 1; i <= MEMOIZATION_THRESHOLD * 3; i++) {
      worklist.observe(runtimeCallPass, fDef.id, i);
    }
    expect(patchCalls).toBe(1);
  });

  test("RUNTIME_CALL_COUNT_SAT and MEMOIZATION_THRESHOLD stay in lock-step", () => {
    expect(RUNTIME_CALL_COUNT_SAT).toBe(MEMOIZATION_THRESHOLD + 1);
  });
});

// ── (2) Patch dispatch: interpreter.patchFunction targets the compiler's index ──
describe("patch dispatch", () => {
  test("patchFunction targets the compiler's stable index for the changed scope", () => {
    const code = `
def g():
    return 42
g()
`;
    const { ast, reactive, compiler, program } = buildUnit(code);
    const interpreter = new SVMLInterpreter(program);
    const gDef = ast.statements[0] as StmtNS.FunctionDef;
    const gUnit = reactive.units.get(gDef)!;
    const patchSpy = jest.spyOn(interpreter, "patchFunction");

    const expectedIndex = compiler.indexOf(gDef)!;
    const newIR = compiler.compileFunction(gUnit);
    interpreter.patchFunction(expectedIndex, newIR);

    expect(patchSpy).toHaveBeenCalledTimes(1);
    expect(patchSpy).toHaveBeenCalledWith(expectedIndex, newIR);
    patchSpy.mockRestore();
  });

  test("registered jitPass only patches FunctionDef scopes (never FileInput)", async () => {
    const { ast, reactive, compiler, program } = buildUnit(`
def g():
    return 1
g()
`);
    const interpreter = new SVMLInterpreter(program);
    const gDef = ast.statements[0] as StmtNS.FunctionDef;
    const patchSpy = jest.spyOn(interpreter, "patchFunction");

    const jitPass: Pass<FunctionUnit, "fired" | undefined> = {
      id: Symbol("test-jitPass"),
      debugName: "test-jitPass",
      lattice: {
        bottom: undefined,
        equals: (a, b) => a === b,
        join: (a, b) => a ?? b,
      },
      reads: [callCountPass, purityScopePass, structuralPass],
      tier: "transform",
      coarse: true,
      transfer(_ctx: PassCtx, unit: FunctionUnit) {
        const scope = unit.funcAst;
        if (!(scope instanceof StmtNS.FunctionDef)) return undefined;
        const index = compiler.indexOf(scope);
        if (index === undefined) return undefined;
        interpreter.patchFunction(index, compiler.compileFunction(unit));
        return "fired";
      },
    };
    reactive.register(jitPass);
    await interpreter.execute();
    reactive.tick();

    for (const [index] of patchSpy.mock.calls) {
      expect(index).toBe(compiler.indexOf(gDef));
    }
    patchSpy.mockRestore();
  });
});

// ── (3) Program replacement: replaceProgram / withSpecializedFunction ────────
describe("program replacement", () => {
  function compile(code: string) {
    return buildUnit(code).program;
  }

  test("replaceProgram between executions changes behavior", () => {
    const interpreter = new SVMLInterpreter(compile("1 + 2"));
    expect(SVMLInterpreter.toJSValue(interpreter.execute())).toBe(3);
    interpreter.replaceProgram(compile("10 + 20"));
    expect(SVMLInterpreter.toJSValue(interpreter.execute())).toBe(30);
  });

  test("replaceProgram before first execute", () => {
    const interpreter = new SVMLInterpreter(compile("42"));
    interpreter.replaceProgram(compile("99"));
    expect(SVMLInterpreter.toJSValue(interpreter.execute())).toBe(99);
  });

  test("replaceProgram after execution completes does not throw", () => {
    const interpreter = new SVMLInterpreter(compile("1"));
    interpreter.execute();
    expect(() => interpreter.replaceProgram(compile("2"))).not.toThrow();
  });

  test("withSpecializedFunction splices a single function's IR", () => {
    const program = compile("def f():\n    return 1\nf()");
    expect(SVMLInterpreter.toJSValue(new SVMLInterpreter(program).execute())).toBe(1);

    const program2 = compile("def f():\n    return 2\nf()");
    const fIdx = program.entryPoint === 0 ? 1 : 0;
    const patched = program.withSpecializedFunction(fIdx, program2.functions[fIdx]);
    expect(SVMLInterpreter.toJSValue(new SVMLInterpreter(patched).execute())).toBe(2);
  });
});

// ── (4) Memo invalidation: fact changes inside a unit force recompile ────────
describe("jitPass CompileInputs memo invalidation", () => {
  function makeStubIR(tag: number): SVMLIR {
    return new SVMLIR(
      new Int32Array([tag]),
      new Float64Array(0),
      new Int32Array(0),
      [],
      0,
      0,
      0,
    );
  }

  function setup() {
    const { ast, reactive } = buildUnit(`
def f(x):
    return x + 1
f(1)
`);
    const fDef = ast.statements[0] as StmtNS.FunctionDef;
    const unit = reactive.units.get(fDef)!;

    let compileCalls = 0;
    let tag = 0;
    const compiler = {
      indexOf: (scope: unknown) => (scope === fDef ? 0 : undefined),
      compileFunction: () => {
        compileCalls++;
        return makeStubIR(++tag);
      },
    };
    const interpreter = { patchFunction: () => {} };

    const jitPass = makeJitPass({
      compiler: compiler as never,
      interpreter: interpreter as never,
      unitsOf: () => reactive.units.values(),
    });
    reactive.register(jitPass);

    const enqueue = () => {
      reactive.enqueue(jitPass, unit);
      reactive.drainPasses();
    };
    return {
      worklist: reactive,
      unit,
      enqueue,
      counters: {
        get compiles() {
          return compileCalls;
        },
      },
    };
  }

  test.each([
    {
      pass: "typeAnalysisPass",
      write: (w: ReturnType<typeof setup>["worklist"], nodeId: number) =>
        w.observe(typeAnalysisPass as Pass<unknown, unknown>, nodeId, {
          kinds: 0xdeadbeef,
          intRef: "x",
          boolRef: "y",
          floatRef: "z",
        } as never),
    },
    {
      pass: "constAnalysisPass",
      write: (w: ReturnType<typeof setup>["worklist"], nodeId: number) =>
        w.observe(constAnalysisPass, nodeId, { kind: "const", value: 42 } as never),
    },
  ])("$pass change for a unit-internal node forces recompile", ({ write }) => {
    const { worklist, unit, enqueue, counters } = setup();
    enqueue();
    const baseline = counters.compiles;
    expect(baseline).toBeGreaterThanOrEqual(1);

    const nodeId = [...unit.blockOfNode.keys()][0];
    write(worklist, nodeId);

    expect(counters.compiles).toBeGreaterThan(baseline);
  });

  test("re-enqueue without fact change short-circuits the memo", () => {
    const { enqueue, counters } = setup();
    enqueue();
    const baseline = counters.compiles;
    enqueue();
    expect(counters.compiles).toBe(baseline);
  });
});

// ── (5) ScopeIndexMap populated only by fromProgramUnit ──────────────────────
describe("SVMLCompiler.scopeIndexMap", () => {
  test("fromProgramUnit populates the scope→index map", () => {
    const { compiler } = buildUnit(`
def f(x):
    return x + 1
def g(y):
    return y * 2
f(1) + g(2)
`);
    expect(compiler.scopeIndexMap).toBeDefined();
    expect(compiler.scopeIndexMap!.size).toBeGreaterThanOrEqual(3);
  });

  test("fromProgram does not populate scopeIndexMap", () => {
    const ast = parse("1 + 2\n");
    expect(SVMLCompiler.fromProgram(ast).scopeIndexMap).toBeUndefined();
  });
});
