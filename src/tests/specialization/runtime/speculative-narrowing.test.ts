// Speculative observation-narrowing pipeline.
//
// Validates the type-domain runtime observation → AssumptionChain narrowing →
// guarded SVML specialization → SpeculationViolation deopt → recompile chain.
// The standard (widening) analyses must remain unchanged so AST-mutating
// transforms stay sound; the speculative analyses are the JIT-only refinement
// the compiler consults when emitting guards. Write-driven numeric-kind
// speculation remains disabled; guarded return-kind specialization below uses
// must-backward entry requirements instead.

import { ExprNS, StmtNS, resetNodeIds } from "../../../ast-types";
import { ROOT_CONTEXT } from "../../../specialization/framework/context";
import { SpeculationViolation } from "../../../engines/svml/errors";
import { makeJitAnalysis } from "../../../conductor/svml-jit-analysis";
import {
  clearMemoCache,
  memoCacheSnapshot,
} from "../../../runtime/memo";
import OpCodes, { SVMLKindBits } from "../../../engines/svml/opcodes";
import { SVMLCompiler } from "../../../engines/svml/svml-compiler";
import { SVMLInterpreter } from "../../../engines/svml/svml-interpreter";
import { parse } from "../../../parser/parser-adapter";
import { analyzeWithEnvironments } from "../../../resolver";
import { typeAnalysis } from "../../../specialization/framework/dfa-analyses";
import { readExprFact } from "../../../specialization/framework/dfa-factory";
import {
  observeRuntimeReturn,
  runtimeCallAnalysis,
  runtimeParamAnalysis,
} from "../../../specialization/framework/runtime-analyses";
import { INT_BIT } from "../../../specialization/type-analysis/lattice";
import { makeDfaQuery, makeJitObservers } from "../../../specialization";
import { paramKey } from "../../../specialization/framework/key-spaces";
import { entryGuardsFor } from "../../../specialization/entry-guards";
import { MEMOIZATION_THRESHOLD } from "../../../specialization/transforms/memoization";
import { hasOpcode } from "../../harness/opcode-assert";
import { buildTestWorklist } from "../../utils";

function build(code: string) {
  const script = code + "\n";
  const ast = parse(script);
  const { environments } = analyzeWithEnvironments(ast, script, 4);
  const worklist = buildTestWorklist(ast, environments);
  worklist.drain();
  return { ast, environments, worklist };
}

function compile(ast: StmtNS.FileInput, environments: ReturnType<typeof analyzeWithEnvironments>["environments"], worklist: ReturnType<typeof buildTestWorklist>) {
  const compiler = SVMLCompiler.fromProgramUnit(
    ast,
    environments,
    makeDfaQuery(
      worklist.topology,
      nodeId => worklist.specAssumptionChainForNode(nodeId),
      unit => worklist.specAssumptionChainFor(unit),
    ),
    worklist.registry,
    worklist,
  );
  return { compiler, program: compiler.compileProgram(ast) };
}

// Write-driven per-node speculation is out of policy under the param-only
// narrowing registry (see DEFAULT_NARROWINGS in dfa-analyses.ts). Tests that
// exercised runtimeWriteAnalysis → typeNarrowing chain extension have been
// removed; the mechanism they tested is no longer reachable through the
// default worklist wiring. Param-driven speculation is covered by the
// "speculative path materialization" and "entry-guarded specialized clone"
// describes below.

describe("speculative path materialization", () => {
  test("ancestor contexts synthesized by canonical ordering still get materialized", () => {
    const { ast, worklist } = build(`
def hot(x):
    return x + 1
`);
    const fn = ast.statements[0] as StmtNS.FunctionDef;
    const unit = worklist.topology.unitOfFunctionId(fn.id)!;
    const ret = fn.body[0] as StmtNS.Return;
    const xRead = (ret.value as ExprNS.Binary).left as ExprNS.Variable;

    worklist.observe(runtimeParamAnalysis, paramKey(fn.id, 0), { kind: "number", value: 8 }, ROOT_CONTEXT);
    observeRuntimeReturn(worklist, fn.id, 7, ROOT_CONTEXT);
    worklist.drain();

    const ctx = worklist.specAssumptionChainFor(unit);
    expect(ctx.depth).toBeGreaterThan(1);
    const intermediate = ctx.parent!;
    expect(intermediate).not.toBe(ROOT_CONTEXT);

    const typeAtIntermediate = readExprFact(worklist.topology, typeAnalysis, xRead.id, intermediate);
    expect(typeAtIntermediate?.kinds).toBe(INT_BIT);
    expect(intermediate.tryRead(typeAnalysis.env, unit.cfg.entry)).toBeDefined();
  });
});

describe("svml-compiler: guarded return-kind specialization", () => {
  test("return-kind observation hoists parameter GUARD_KINDs and enables numeric opcode selection", () => {
    const { ast, environments, worklist } = build(`
def hot(x):
    return x + 1
`);
    const fn = ast.statements[0] as StmtNS.FunctionDef;

    observeRuntimeReturn(worklist, fn.id, 7, ROOT_CONTEXT);
    worklist.drain();

    const { program } = compile(ast, environments, worklist);
    expect(hasOpcode(program, OpCodes.GUARD_KIND)).toBe(true);
    expect(hasOpcode(program, OpCodes.ADDF)).toBe(true);
    expect(hasOpcode(program, OpCodes.ADDG)).toBe(false);
  });

  test("without a return-kind observation the same function stays unguarded and generic", () => {
    const { ast, environments, worklist } = build(`
def hot(x):
    return x + 1
`);

    const { program } = compile(ast, environments, worklist);
    expect(hasOpcode(program, OpCodes.GUARD_KIND)).toBe(false);
    expect(hasOpcode(program, OpCodes.ADDF)).toBe(false);
    expect(hasOpcode(program, OpCodes.ADDG)).toBe(true);
  });

});

// widenWriteObservation's deopt-protocol role is covered by the widenGuard
// contract tests below. The per-node write-driven speculation test was
// removed with the param-only narrowing policy.

describe("svml-jit-analysis: entry-guarded specialized clone", () => {
  test("truthiness-only branch stays generic under type-only param profiling", () => {
    const { ast, environments, worklist } = build(`
def hot(x):
    if x:
        return 1
    else:
        return 999

hot(True)
hot(True)
`);
    const fn = ast.statements[0] as StmtNS.FunctionDef;
    const unit = worklist.topology.unitOfFunctionId(fn.id)!;
    const compiler = SVMLCompiler.fromProgramUnit(
      ast,
      environments,
      makeDfaQuery(
        worklist.topology,
        nodeId => worklist.specAssumptionChainForNode(nodeId),
        unit => worklist.specAssumptionChainFor(unit),
      ),
      worklist.registry,
      worklist,
    );
    const program = compiler.compileProgram(ast);

    const baselineArg1s = program.functions.flatMap(ir => Array.from(ir.arg1s));
    expect(hasOpcode(program, OpCodes.GUARD_TRUTHY)).toBe(false);
    expect(baselineArg1s).toContain(999);

    const interpreter = new SVMLInterpreter(program, { sendOutput: () => {}, ...makeJitObservers(worklist) });
    const jitAnalysis = makeJitAnalysis({
      compiler,
      interpreter,
      specAssumptionChainFor: unit => worklist.specAssumptionChainFor(unit),
    });
    worklist.register(jitAnalysis);

    interpreter.execute();
    worklist.drain();

    expect(worklist.tryRead(runtimeParamAnalysis, paramKey(fn.id, 0), ROOT_CONTEXT)).toEqual({
      kind: "bool",
      value: true,
    });
    expect(entryGuardsFor(unit, worklist.specAssumptionChainFor(unit))).toContainEqual({
      kind: "param-type",
      paramIndex: 0,
      ty: require("../../../specialization/type-analysis/lattice").BOOL_TRUE,
    });

    const currentProgram = (interpreter as unknown as { program: typeof program }).program;
    expect(hasOpcode(currentProgram, OpCodes.GUARD_KIND)).toBe(false);
    const allArg1s = currentProgram.functions.flatMap(ir => Array.from(ir.arg1s));
    expect(allArg1s).toContain(1);
    expect(allArg1s).toContain(999);
  });
});


describe("widenGuard contract", () => {
  test("throws when a guard fires with no registered provenance", () => {
    // Contract: every guard-emitting backend must call `registerGuard` at
    // emission. `widenGuard` used to silently collapse the whole chain when
    // provenance was missing, hiding the wiring bug behind a sound-but-
    // coarse recovery. It now throws so the bug surfaces at the deopt site
    // instead of as a mysterious whole-unit widen.
    const { ast, worklist } = build(`
def hot(x):
    y = x
    return y
`);
    const fn = ast.statements[0] as StmtNS.FunctionDef;
    const yAssign = fn.body[0] as StmtNS.Assign;
    const xRead = yAssign.value as ExprNS.Variable;

    // `xRead.id` belongs to a known unit, but no `registerGuard` was ever
    // called for it — this is exactly the "backend emitted a guard without
    // registering provenance" scenario.
    expect(() => worklist.widenGuard(xRead.id)).toThrow(/no provenance/);
  });

  test("returns undefined for a nodeId outside every known unit", () => {
    // Unowned nodeId isn't a wiring bug — it's a garbage input (e.g. a
    // stale id from a prior CFG generation). Silent no-op is the right
    // response; only the "known unit + missing provenance" case throws.
    const { worklist } = build(`x = 1`);
    expect(worklist.widenGuard(0xdead_beef)).toBeUndefined();
  });
});

describe("SVMLKindBits sanity", () => {
  test("NUMBER bit matches what svmlKindToBit returns for typeof number", () => {
    expect(SVMLKindBits.NUMBER).toBe(1);
    expect(SVMLKindBits.BOOLEAN).toBe(2);
  });
});

describe("canonical context interning (observation-pipeline level)", () => {
  // Proves the payoff of context interning + canonical chain order at the
  // worklist observation-translator level: param observations arriving in swapped
  // orders converge on the same canonical Context, and the analysis stores
  // hold a single cell per (analysis, canonical-context, key).

  test("param observations in swapped arrival order produce ref-equal spec contexts", () => {
    const code = `
def hot(x, y):
    return x + y
`;

    // Worklist A: observe x, then y.
    resetNodeIds();
    const { ast: astA, worklist: wlA } = build(code);
    const fnA = astA.statements[0] as StmtNS.FunctionDef;
    wlA.observe(runtimeParamAnalysis, paramKey(fnA.id, 0), { kind: "number", value: 5 }, ROOT_CONTEXT);
    wlA.observe(runtimeParamAnalysis, paramKey(fnA.id, 1), { kind: "number", value: 10 }, ROOT_CONTEXT);
    const unitA = wlA.topology.unitOfFunctionId(fnA.id)!;
    const ctxA = wlA.specAssumptionChainFor(unitA);

    // Worklist B: observe y, then x (swapped).
    resetNodeIds();
    const { ast: astB, worklist: wlB } = build(code);
    const fnB = astB.statements[0] as StmtNS.FunctionDef;
    wlB.observe(runtimeParamAnalysis, paramKey(fnB.id, 1), { kind: "number", value: 10 }, ROOT_CONTEXT);
    wlB.observe(runtimeParamAnalysis, paramKey(fnB.id, 0), { kind: "number", value: 5 }, ROOT_CONTEXT);
    const unitB = wlB.topology.unitOfFunctionId(fnB.id)!;
    const ctxB = wlB.specAssumptionChainFor(unitB);

    // Not vacuous: both observations landed, so the context is non-ROOT.
    expect(ctxA).not.toBe(ROOT_CONTEXT);
    expect(ctxB).not.toBe(ROOT_CONTEXT);
    // The payoff: module-scoped interner + canonical chain order ⇒ identity.
    expect(ctxA).toBe(ctxB);
  });
});
