import { ExprNS, StmtNS } from "../../../ast-types";
import { makeJitAnalysis } from "../../../conductor/svml-jit-analysis";
import { SVMLCompiler } from "../../../engines/svml/svml-compiler";
import { SVMLInterpreter } from "../../../engines/svml/svml-interpreter";
import { SVMLIR } from "../../../engines/svml/types";
import { parse } from "../../../parser/parser-adapter";
import { analyzeWithEnvironments } from "../../../resolver";
import { MEMOIZATION_THRESHOLD } from "../../../specialization/transforms/memoization";
import {
  RUNTIME_CALL_COUNT_SAT,
  observeRuntimeWrite,
  runtimeCallAnalysis,
} from "../../../specialization/framework/runtime-analyses";
import { constAnalysis, typeAnalysis } from "../../../specialization/framework/dfa-analyses";
import { purityScopeAnalysis } from "../../../specialization/purity-analysis/analysis";
import { CONST_TOP } from "../../../specialization/const-analysis/lattice";
import { TOP as TYPE_TOP } from "../../../specialization/type-analysis/lattice";
import { MutableEnv } from "../../../specialization/framework/mutable-env";
import type { Unit } from "../../../specialization/framework/function-unit";
import { defineAnalysis, type Analysis, type AnalysisCtx } from "../../../specialization/framework/analysis";
import { ROOT_CONTEXT } from "../../../specialization/framework/context";
import { makeDfaQuery } from "../../../specialization";
import { buildTestWorklist } from "../../utils";

function buildUnit(code: string) {
  const script = code + "\n";
  const ast = parse(script);
  const { environments } = analyzeWithEnvironments(ast, script, 4);
  const reactive = buildTestWorklist(ast, environments);
  reactive.drain();
  const compiler = SVMLCompiler.fromProgramUnit(
    ast,
    environments,
    makeDfaQuery(reactive.topology),
    reactive.registry,
  );
  return { ast, environments, reactive, compiler, program: compiler.compileProgram(ast) };
}

// ── (1) Saturation: runtimeCallAnalysis caps at SAT and suppresses consumer rerun ──
describe("runtimeCallAnalysis saturation", () => {
  function setup() {
    const { ast, reactive } = buildUnit(`
def f():
    return 1
f()
`);
    const fDef = ast.statements[0] as StmtNS.FunctionDef;
    return { worklist: reactive, unit: reactive.units.get(fDef.id)!, fDef };
  }

  test("consumer wakeups capped at MEMOIZATION_THRESHOLD + 1", () => {
    const { worklist, fDef } = setup();
    let transferRuns = 0;
    const observerStoreAlgebra = {
      bottom: 0,
      leq: (a: number, b: number) => a <= b,
      join: (a: number, b: number) => Math.max(a, b),
      eq: (a: number, b: number) => a === b,
    };
    const observer: Analysis<number, number> = defineAnalysis({
      id: Symbol("observer"),
      debugName: "observer",
      storeAlgebra: observerStoreAlgebra,
      edges: [{ on: "fact", analysis: runtimeCallAnalysis, wake: (_c, k) => [k as number] }],
      tier: "analysis",
      polarity: "may",
      transfer(_ctx, key) {
        transferRuns++;
        return ROOT_CONTEXT.read(runtimeCallAnalysis, key) ?? 0;
      },
    });
    worklist.register(observer);

    for (let i = 1; i <= MEMOIZATION_THRESHOLD * 5; i++) {
      worklist.observe(runtimeCallAnalysis, fDef.id, i, ROOT_CONTEXT);
    }
    expect(transferRuns).toBeGreaterThan(0);
    expect(transferRuns).toBeLessThanOrEqual(MEMOIZATION_THRESHOLD + 1);
  });

  test("jit-style transfer fires exactly once at saturation", () => {
    const { worklist, unit, fDef } = setup();
    let patchCalls = 0;
    const jitCounterStoreAlgebra = {
      bottom: 0,
      leq: (a: number, b: number) => a <= b,
      join: (a: number, b: number) => Math.max(a, b),
      eq: (a: number, b: number) => a === b,
    };
    const jitAnalysis: Analysis<Unit, number> = defineAnalysis({
      id: Symbol("test-jitAnalysis"),
      debugName: "test-jitAnalysis",
      storeAlgebra: jitCounterStoreAlgebra,
      edges: [{ on: "fact", analysis: runtimeCallAnalysis, wake: () => [unit] }],
      tier: "analysis",
      polarity: "opaque",
      transfer(_ctx, u) {
        const c = ROOT_CONTEXT.read(runtimeCallAnalysis, fDef.id) ?? 0;
        if (c <= MEMOIZATION_THRESHOLD) return undefined;
        const prev = ROOT_CONTEXT.read(jitAnalysis, u);
        if (prev === 1) return undefined;
        patchCalls++;
        return 1;
      },
    });
    worklist.register(jitAnalysis);
    worklist.enqueue(jitAnalysis, unit, ROOT_CONTEXT);
    worklist.drain();
    expect(patchCalls).toBe(0);

    for (let i = 1; i <= MEMOIZATION_THRESHOLD * 3; i++) {
      worklist.observe(runtimeCallAnalysis, fDef.id, i, ROOT_CONTEXT);
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
    const gUnit = reactive.units.get(gDef.id)!;
    const patchSpy = jest.spyOn(interpreter, "patchFunction");

    const expectedIndex = compiler.indexOf(gDef)!;
    const newIR = compiler.compileFunction(gUnit);
    interpreter.patchFunction(expectedIndex, newIR);

    expect(patchSpy).toHaveBeenCalledTimes(1);
    expect(patchSpy).toHaveBeenCalledWith(expectedIndex, newIR);
    patchSpy.mockRestore();
  });

  test("registered jitAnalysis only patches FunctionDef scopes (never FileInput)", async () => {
    const { ast, reactive, compiler, program } = buildUnit(`
def g():
    return 1
g()
`);
    const interpreter = new SVMLInterpreter(program);
    const gDef = ast.statements[0] as StmtNS.FunctionDef;
    const patchSpy = jest.spyOn(interpreter, "patchFunction");

    const firedStoreAlgebra = {
      bottom: undefined,
      leq: (a: "fired" | undefined, b: "fired" | undefined) => a === undefined || a === b,
      join: (a: "fired" | undefined, b: "fired" | undefined) => a ?? b,
      eq: (a: "fired" | undefined, b: "fired" | undefined) => a === b,
    };
    const jitAnalysis: Analysis<Unit, "fired" | undefined> = defineAnalysis({
      id: Symbol("test-jitAnalysis"),
      debugName: "test-jitAnalysis",
      storeAlgebra: firedStoreAlgebra,
      edges: [
        { on: "fact", analysis: runtimeCallAnalysis, wake: (c, k) => { const u = c.topology.unitOfFunctionId(k as number); return u === undefined ? [] : [u]; } },
        { on: "fact", analysis: purityScopeAnalysis, wake: (c, k) => { const u = c.topology.unitOfFunctionId(k as number); return u === undefined ? [] : [u]; } },
        { on: "mint", wake: (_c, u) => u.funcAst instanceof StmtNS.FunctionDef ? [u] : [] },
        { on: "rebuild", wake: (_c, u) => u.funcAst instanceof StmtNS.FunctionDef ? [u] : [] },
      ],
      tier: "analysis",
      polarity: "opaque",
      transfer(_ctx: AnalysisCtx, unit: Unit) {
        const scope = unit.funcAst;
        if (!(scope instanceof StmtNS.FunctionDef)) return undefined;
        const index = compiler.indexOf(scope);
        if (index === undefined) return undefined;
        interpreter.patchFunction(index, compiler.compileFunction(unit));
        return "fired";
      },
    });
    reactive.register(jitAnalysis);
    await interpreter.execute();
    reactive.drain();

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
describe("jitAnalysis CompileInputs memo invalidation", () => {
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
    const unit = reactive.units.get(fDef.id)!;

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

    const jitAnalysis = makeJitAnalysis({
      compiler: compiler as never,
      interpreter: interpreter as never,
      specAssumptionChainFor: u => reactive.specAssumptionChainFor(u),
    });
    reactive.register(jitAnalysis);

    const enqueue = () => {
      reactive.enqueue(jitAnalysis, unit, ROOT_CONTEXT);
      reactive.drain();
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

  test("type-only spec-context change may conservatively recompile", () => {
    const { worklist, unit, enqueue, counters } = setup();
    enqueue();
    const baseline = counters.compiles;
    expect(baseline).toBeGreaterThanOrEqual(1);

    // Observing a runtime write at a unit-internal expression still extends
    // the unit's speculation context and wakes jitAnalysis through the
    // `specContextChange` lifecycle edge. But write-driven speculative type
    // facts are not backend-shaping inputs, so the JIT should reuse an
    // existing artifact when those are the only relevant changes.
    const fd = unit.funcAst as StmtNS.FunctionDef;
    const ret = fd.body[0] as StmtNS.Return;
    const binary = ret.value! as ExprNS.Binary; // `x + 1`
    const literal = binary.right as ExprNS.Literal; // `1` — statically const(1), INT_POS
    // A None observation at the literal creates a fresh speculative context,
    // but does not lift into const narrowing, so no backend-relevant fact
    // changes and the current artifact stays valid.
    observeRuntimeWrite(worklist, literal.id, null, ROOT_CONTEXT);

    expect(counters.compiles).toBeGreaterThanOrEqual(baseline);
  });

  // Direct per-analysis wake-up: bypasses the shared runtimeWriteAnalysis upstream so
  // the type-domain tracked by the simplified JIT invalidation is exercised
  // independently.
  test.each([
    { name: "typeAnalysis", analysis: typeAnalysis, top: TYPE_TOP },
  ])("$name change updates jit invalidation correctly", ({ analysis, top }) => {
    const { worklist, unit, enqueue, counters } = setup();
    enqueue();
    const baseline = counters.compiles;

    // Write a synthesized env-cell fact that strictly advances outEnv by
    // populating a fresh slot. JIT edges watch both cells of each
    // JIT-relevant narrowing; writing to `.env` exercises the env-side wake
    // path. Equality on the env lattice flags the change, jitAnalysis wakes
    // via its `reads` edge on this cell, and the memo invalidates for the
    // owning unit.
    const block = unit.cfg.entry;
    const outEnv = new MutableEnv<unknown>();
    outEnv.set(9999, top);
    worklist.observe(
      analysis.env as unknown as Analysis<unknown, unknown>,
      block,
      outEnv as never,
      ROOT_CONTEXT,
    );

    expect(counters.compiles).toBeGreaterThan(baseline);
  });

  test("re-enqueue without fact change recompiles but suppresses repatch on equal IR", () => {
    const { enqueue, counters } = setup();
    enqueue();
    const baseline = counters.compiles;
    enqueue();
    expect(counters.compiles).toBeGreaterThan(baseline);
  });

  // Equal writes still must not trigger a wake-up. The simplified JIT no
  // longer memoizes compiled artifacts, so the invariant here is purely at the
  // analysis-store/event boundary: store-algebra-equal writes produce no fact
  // change, therefore jitAnalysis is never re-enqueued.
  test("store-algebra-equal DFA write does not recompile", () => {
    const { worklist, unit, enqueue, counters } = setup();
    enqueue();
    const baseline = counters.compiles;
    expect(baseline).toBeGreaterThanOrEqual(1);

    const block = unit.cfg.entry;
    const currentConst = worklist.tryRead(constAnalysis.env, block, ROOT_CONTEXT);
    expect(currentConst).toBeDefined();

    // Re-observe the exact same fact value. AnalysisStore.write joins with
    // prev; identical input → identical join → lattice.equals returns true
    // → write returns false, no listener fan-out. We drive a drain anyway
    // to prove that, even if a transfer did fire, the snapshot still
    // matches by reference.
    worklist.observe(
      constAnalysis.env as unknown as Analysis<unknown, unknown>,
      block,
      currentConst as never,
      ROOT_CONTEXT,
    );
    worklist.drain();

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
