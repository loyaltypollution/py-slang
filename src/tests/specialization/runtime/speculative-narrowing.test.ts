// Speculative observation-narrowing pipeline.
//
// Validates the `runtimeWriteAnalysis → speculative{Type,Const}Analysis →
// svml-compiler GUARD_TRUTHY emission → SpeculationViolation deopt → recompile`
// chain. The standard (widening) analyses must remain unchanged so AST-mutating
// transforms stay sound; the speculative analyses are the JIT-only refinement
// the compiler consults when emitting guards. Write-driven numeric-kind
// speculation remains disabled; guarded return-kind specialization below uses
// must-backward entry requirements instead.

import { ExprNS, StmtNS, resetNodeIds } from "../../../ast-types";
import { findAssumption, ROOT_CONTEXT } from "../../../specialization/framework/context";
import { constExprHandle } from "../../../specialization/const-analysis/analysis";
import { typeExprHandle } from "../../../specialization/type-analysis/analysis";
import { SpeculationViolation } from "../../../engines/svml/errors";
import { makeJitAnalysis } from "../../../conductor/svml-jit-analysis";
import OpCodes, { SVMLKindBits } from "../../../engines/svml/opcodes";
import { SVMLCompiler } from "../../../engines/svml/svml-compiler";
import { SVMLInterpreter } from "../../../engines/svml/svml-interpreter";
import { parse } from "../../../parser/parser-adapter";
import { analyzeWithEnvironments } from "../../../resolver";
import {
  returnKindHandle,
  typeAnalysis,
} from "../../../specialization/framework/dfa-analyses";
import { readExprFact } from "../../../specialization/framework/dfa-factory";
import {
  observeRuntimeReturn,
  runtimeWriteAnalysis,
  widenWriteObservation,
} from "../../../specialization/framework/runtime-analyses";
import { INT_BIT } from "../../../specialization/type-analysis/lattice";
import { makeDfaQuery } from "../../../specialization";
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
      nodeId => worklist.specContextForNode(nodeId),
      unit => worklist.specContextFor(unit),
    ),
    worklist.registry,
    worklist,
  );
  return { compiler, program: compiler.compileProgram(ast) };
}

describe("speculative analysis: meet vs join", () => {
  test("widening analysis preserves TOP under observation; speculative analysis narrows to the singleton", () => {
    const { ast, worklist } = build(`
def hot(x):
    y = x
    return y * 2
`);
    const fn = ast.statements[0] as StmtNS.FunctionDef;
    const assign = fn.body[0] as StmtNS.Assign;
    const xRead = assign.value as ExprNS.Variable; // RHS of `y = x`

    // Inject a runtime observation as if SVMLInterpreter.dispatchWriteSite
    // had fired with value 5 at this STORE site.
    worklist.observe(runtimeWriteAnalysis, xRead.id, { kind: "number", value: 5 });
    worklist.drain();

    expect(worklist.tryRead(runtimeWriteAnalysis, xRead.id)).toEqual({ kind: "number", value: 5 });

    const widened = readExprFact(
      worklist.topology,
      typeAnalysis, xRead.id);
    // Speculative read: same typeAnalysis, per-unit speculation context that
    // the observation→context translator extended on the observe above.
    const narrowed = readExprFact(
      worklist.topology,
      typeAnalysis,
      xRead.id,
      worklist.specContextForNode(xRead.id),
    );

    // `x` is a parameter — slot type is TOP. Widening analysis sees that `join(TOP, INT_POS) = TOP`.
    expect(widened?.kinds).not.toBe(INT_BIT);
    // Narrowing via context assumption: `meet(TOP, INT_POS) = INT_POS`.
    expect(narrowed?.kinds).toBe(INT_BIT);
  });
});

// Numeric specialization remains disabled for write-driven speculative type
// narrowings, but return-kind speculation now consumes must-backward entry
// requirements in a guarded way: the compiler may hoist entry GUARD_KINDs for
// parameters and then select specialized numeric opcodes in that guarded body.

describe("svml-compiler: guarded return-kind specialization", () => {
  test("return-kind observation hoists parameter GUARD_KINDs and enables numeric opcode selection", () => {
    const { ast, environments, worklist } = build(`
def hot(x):
    return x + 1
`);
    const fn = ast.statements[0] as StmtNS.FunctionDef;

    observeRuntimeReturn(worklist, fn.id, 7);
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

  test("lineage-precise widen for return-kind deopt retains sibling write-driven speculation", () => {
    const { ast, environments, worklist } = build(`
def hot(x, mode):
    y = mode
    if y > 0:
        return x + 1
    else:
        return 999

hot("oops", 1)
`);
    const fn = ast.statements[0] as StmtNS.FunctionDef;
    const modeRead = (fn.body[0] as StmtNS.Assign).value as ExprNS.Variable;

    worklist.observe(runtimeWriteAnalysis, modeRead.id, { kind: "number", value: 1 });
    observeRuntimeReturn(worklist, fn.id, 7);
    worklist.drain();

    const { compiler, program } = compile(ast, environments, worklist);
    const interpreter = new SVMLInterpreter(program, { sendOutput: () => {} });
    const jitAnalysis = makeJitAnalysis({
      compiler,
      interpreter,
      specContextFor: unit => worklist.specContextFor(unit),
    });
    worklist.register(jitAnalysis);

    expect(hasOpcode(program, OpCodes.GUARD_KIND)).toBe(true);
    expect(hasOpcode(program, OpCodes.GUARD_TRUTHY)).toBe(true);

    let violation: SpeculationViolation | undefined;
    try {
      interpreter.execute();
    } catch (e) {
      if (!(e instanceof SpeculationViolation)) throw e;
      violation = e;
    }
    expect(violation).toBeDefined();
    expect(violation!.nodeId).toBe((fn.body[0] as StmtNS.Assign).id);

    worklist.widenGuard(violation!.nodeId);
    worklist.drain();

    const unit = worklist.units.get(fn.id)!;
    const ctx = worklist.specContextFor(unit);
    expect(findAssumption(ctx, returnKindHandle, fn.id)).toBeUndefined();
    expect(findAssumption(ctx, constExprHandle, modeRead.id)).toBeDefined();

    const currentProgram = (interpreter as unknown as { program: typeof program }).program;
    expect(hasOpcode(currentProgram, OpCodes.GUARD_KIND)).toBe(false);
    expect(hasOpcode(currentProgram, OpCodes.GUARD_TRUTHY)).toBe(true);
  });
});

describe("widenWriteObservation: deopt-protocol primitive", () => {
  test("writing ⊤ at a node erases speculative narrowing on next analysis", () => {
    const { ast, worklist } = build(`
def hot(x):
    y = x
    return y * 2
`);
    const fn = ast.statements[0] as StmtNS.FunctionDef;
    const xRead = (fn.body[0] as StmtNS.Assign).value as ExprNS.Variable;
    worklist.observe(runtimeWriteAnalysis, xRead.id, { kind: "number", value: 5 });
    worklist.drain();

    const before = readExprFact(
      worklist.topology,
      typeAnalysis,
      xRead.id,
      worklist.specContextForNode(xRead.id),
    );
    expect(before?.kinds).toBe(INT_BIT);

    widenWriteObservation(worklist, xRead.id);
    worklist.drain();

    // The translator prunes the assumption on ⊤ observations; the spec
    // context collapses back to ROOT (or one level below, if other
    // assumptions exist). Re-read under the current context.
    const after = readExprFact(
      worklist.topology,
      typeAnalysis,
      xRead.id,
      worklist.specContextForNode(xRead.id),
    );
    // After widening, no narrowing assumption remains; fact falls back to
    // the static/widened value, which is TOP for an unannotated parameter.
    expect(after?.kinds).not.toBe(INT_BIT);
  });
});

describe("svml-compiler: speculative dead-branch (GUARD_TRUTHY)", () => {
  test("speculative const proves cond → emits GUARD_TRUTHY + only the taken arm", () => {
    // mode is statically TOP (parameter). Observation pins the read to int 1.
    // Speculative const flows: y = mode → slot(y) = const(1). Then `y > 0`
    // is speculatively const(true). Compiler drops the else arm entirely.
    // Using explicit else: a bare statement after `if` is NOT in the if's
    // else block (Python AST puts it as a sibling), so it wouldn't be
    // dropped — only the if's own else branch can be eliminated.
    const { ast, environments, worklist } = build(`
def hot(mode):
    y = mode
    if y > 0:
        return 1
    else:
        return 999
`);
    const fn = ast.statements[0] as StmtNS.FunctionDef;
    const yAssign = fn.body[0] as StmtNS.Assign;
    const modeRead = yAssign.value as ExprNS.Variable;
    worklist.observe(runtimeWriteAnalysis, modeRead.id, { kind: "number", value: 1 });

    const { program } = compile(ast, environments, worklist);
    expect(hasOpcode(program, OpCodes.GUARD_TRUTHY)).toBe(true);

    // Dead-arm signature: the literal 999 should not appear in any function's
    // constant pool / opcode stream because the else arm was never compiled.
    const allArg1s = program.functions.flatMap(fn => Array.from(fn.arg1s));
    expect(allArg1s).not.toContain(999);
    expect(allArg1s).toContain(1); // taken arm survives
  });

  test("static const cond → no GUARD_TRUTHY (existing static fold path handles it)", () => {
    // `if 1 > 0:` is statically constant. The static const analysis folds it;
    // speculativeConditionTruth must not fire (would emit a redundant guard).
    const { ast, environments, worklist } = build(`
def hot(x):
    if 1 > 0:
        return x
    return 999
`);
    const { program } = compile(ast, environments, worklist);
    expect(hasOpcode(program, OpCodes.GUARD_TRUTHY)).toBe(false);
  });

  test("GUARD_TRUTHY mismatch → SpeculationViolation; widen retracts speculation and drops the guard on recompile", () => {
    // Observation says mode=1 (truthy). Runtime call analyses mode=0 (falsy).
    // Guard fires → widen unit spec → recompile → no more GUARD_TRUTHY → both
    // arms restored.
    const { ast, environments, worklist } = build(`
def hot(mode):
    y = mode
    if y > 0:
        return 1
    else:
        return 999

hot(0)
`);
    const fn = ast.statements[0] as StmtNS.FunctionDef;
    const yAssign = fn.body[0] as StmtNS.Assign;
    const modeRead = yAssign.value as ExprNS.Variable;
    // Pre-seed with a positive observation (as if the function had been called
    // with mode=1 before; the actual call below analyses 0 to trigger violation).
    worklist.observe(runtimeWriteAnalysis, modeRead.id, { kind: "number", value: 1 });

    const { compiler, program } = compile(ast, environments, worklist);
    const interpreter = new SVMLInterpreter(program, { sendOutput: () => {} });
    const jitAnalysis = makeJitAnalysis({
      compiler,
      interpreter,
      specContextFor: unit => worklist.specContextFor(unit),
    });
    worklist.register(jitAnalysis);

    expect(hasOpcode(program, OpCodes.GUARD_TRUTHY)).toBe(true);

    let violation: SpeculationViolation | undefined;
    try {
      interpreter.execute();
    } catch (e) {
      if (!(e instanceof SpeculationViolation)) throw e;
      violation = e;
    }
    expect(violation).toBeDefined();

    worklist.widenGuard(violation!.nodeId);
    worklist.drain();

    const currentProgram = (interpreter as unknown as { program: typeof program }).program;
    expect(hasOpcode(currentProgram, OpCodes.GUARD_TRUTHY)).toBe(false);
    // Else arm restored: literal 999 reappears.
    const restoredArg1s = currentProgram.functions.flatMap(fn => Array.from(fn.arg1s));
    expect(restoredArg1s).toContain(999);
  });

  test("lineage-precise widen: sibling guard backed by an independent observation survives", () => {
    // Two independent observations, each driving its own GUARD_TRUTHY in the
    // same function. One guard fires at runtime; C5b's lineage-precise widen
    // must prune only the observation that drove the fired guard — the
    // sibling guard (protected by the untouched observation) must survive
    // the recompile. Under C5a's whole-unit reset, BOTH guards would vanish.
    const { ast, environments, worklist } = build(`
def hot(a, b):
    x = a
    y = b
    if x > 0:
        r1 = 1
    else:
        r1 = 2
    if y > 0:
        r2 = 10
    else:
        r2 = 20
    return r1 + r2

hot(1, 0)
`);
    const fn = ast.statements[0] as StmtNS.FunctionDef;
    const xAssign = fn.body[0] as StmtNS.Assign;
    const yAssign = fn.body[1] as StmtNS.Assign;
    const aRead = xAssign.value as ExprNS.Variable;
    const bRead = yAssign.value as ExprNS.Variable;
    const if1 = fn.body[2] as StmtNS.If;
    const if2 = fn.body[3] as StmtNS.If;
    const cond1Id = if1.condition.id;
    const cond2Id = if2.condition.id;

    // Pre-seed both parameters as truthy; hot(1, 0) will fire the y>0 guard.
    worklist.observe(runtimeWriteAnalysis, aRead.id, { kind: "number", value: 1 });
    worklist.observe(runtimeWriteAnalysis, bRead.id, { kind: "number", value: 1 });

    const { compiler, program } = compile(ast, environments, worklist);
    const interpreter = new SVMLInterpreter(program, { sendOutput: () => {} });
    const jitAnalysis = makeJitAnalysis({
      compiler,
      interpreter,
      specContextFor: unit => worklist.specContextFor(unit),
    });
    worklist.register(jitAnalysis);

    const guardArgs = (p: typeof program): number[] => {
      const ids: number[] = [];
      for (const fn of p.functions) {
        for (let i = 0; i < fn.count; i++) {
          if (fn.opcodes[i] === OpCodes.GUARD_TRUTHY) ids.push(fn.arg1s[i]);
        }
      }
      return ids;
    };
    // Both guards present initially.
    expect(guardArgs(program).sort()).toEqual([cond1Id, cond2Id].sort());

    let violation: SpeculationViolation | undefined;
    try {
      interpreter.execute();
    } catch (e) {
      if (!(e instanceof SpeculationViolation)) throw e;
      violation = e;
    }
    expect(violation).toBeDefined();
    expect(violation!.nodeId).toBe(cond2Id); // the y>0 guard fired

    worklist.widenGuard(violation!.nodeId);
    worklist.drain();

    const currentProgram = (interpreter as unknown as { program: typeof program }).program;
    // Lineage-precise: cond1's GUARD_TRUTHY survives (backed by a's
    // observation, which wasn't widened); cond2's is gone (b's observation
    // was pruned).
    expect(guardArgs(currentProgram)).toEqual([cond1Id]);
  });

  test("precise deopt reuses a pre-built sibling artifact without recompiling", () => {
    const { ast, environments, worklist } = build(`
def hot(a, b):
    x = a
    y = b
    if x > 0:
        r1 = 1
    else:
        r1 = 2
    if y > 0:
        r2 = 10
    else:
        r2 = 20
    return r1 + r2

hot(1, 0)
`);
    const fn = ast.statements[0] as StmtNS.FunctionDef;
    const xAssign = fn.body[0] as StmtNS.Assign;
    const yAssign = fn.body[1] as StmtNS.Assign;
    const aRead = xAssign.value as ExprNS.Variable;
    const bRead = yAssign.value as ExprNS.Variable;
    const yCond = (fn.body[3] as StmtNS.If).condition;
    const unit = worklist.topology.unitOfNode(aRead.id)!;

    const { compiler, program } = compile(ast, environments, worklist);
    const interpreter = new SVMLInterpreter(program, { sendOutput: () => {} });
    const compileSpy = jest.spyOn(compiler, "compileFunction");
    const jitAnalysis = makeJitAnalysis({
      compiler,
      interpreter,
      specContextFor: trackedUnit => worklist.specContextFor(trackedUnit),
    });
    worklist.register(jitAnalysis);
    worklist.drain();

    worklist.observe(runtimeWriteAnalysis, aRead.id, { kind: "number", value: 1 });
    worklist.drain();
    const ctxA = worklist.specContextFor(unit);
    const compilesAfterA = compileSpy.mock.calls.length;

    worklist.observe(runtimeWriteAnalysis, bRead.id, { kind: "number", value: 1 });
    worklist.drain();
    const compilesAfterAB = compileSpy.mock.calls.length;
    expect(compilesAfterAB).toBeGreaterThan(compilesAfterA);

    let violation: SpeculationViolation | undefined;
    try {
      interpreter.execute();
    } catch (e) {
      if (!(e instanceof SpeculationViolation)) throw e;
      violation = e;
    }
    expect(violation).toBeDefined();
    expect(violation!.nodeId).toBe(yCond.id);

    worklist.widenGuard(violation!.nodeId);
    worklist.drain();

    // The fired guard prunes only the load-bearing const assumption for `b`.
    // The non-load-bearing type assumption at `bRead` survives, so the
    // resulting context is still distinct from the older sibling `ctxA`
    // (which only carried `a`'s assumptions). Because the const fact at the
    // fired branch really changed, the JIT may still need one recompile here.
    const pruned = worklist.specContextFor(unit);
    expect(pruned).not.toBe(ROOT_CONTEXT);
    expect(pruned).not.toBe(ctxA);
    expect(findAssumption(pruned, constExprHandle, bRead.id)).toBeUndefined();
    expect(findAssumption(pruned, typeExprHandle, bRead.id)).toBeDefined();
    expect(compileSpy.mock.calls.length).toBeGreaterThanOrEqual(compilesAfterAB);
  });

  test("lineage-precise widen: pruned context retains the non-load-bearing narrowing", () => {
    // Observation at modeRead lifts BOTH narrowings (constExprHandle@modeRead
    // and typeExprHandle@modeRead). Only `constExprHandle@modeRead` is
    // load-bearing for the const fact the GUARD_TRUTHY protects: removing
    // the const assumption widens cond's const fact to TOP, removing the type
    // assumption does not (const analysis doesn't consult type narrowings).
    //
    // Post-deopt, `widenGuard` must retain `typeExprHandle@modeRead` —
    // whole-chain reset would drop both and land at ROOT. This test is the
    // regression guard: if `compileFunction` ever stops passing the
    // guardRegistrar through to its sub-compiler, `registerGuard` no-ops
    // during jit recompile and `widenGuard` throws on missing provenance,
    // surfacing the wiring bug immediately instead of silently collapsing.
    const { ast, environments, worklist } = build(`
def hot(mode):
    y = mode
    if y > 0:
        return 1
    else:
        return 999

hot(0)
`);
    const fn = ast.statements[0] as StmtNS.FunctionDef;
    const modeRead = (fn.body[0] as StmtNS.Assign).value as ExprNS.Variable;

    const { compiler, program } = compile(ast, environments, worklist);
    const interpreter = new SVMLInterpreter(program, { sendOutput: () => {} });
    const compileSpy = jest.spyOn(compiler, "compileFunction");

    const jitAnalysis = makeJitAnalysis({
      compiler,
      interpreter,
      specContextFor: unit => worklist.specContextFor(unit),
    });
    worklist.register(jitAnalysis);
    worklist.drain();

    worklist.observe(runtimeWriteAnalysis, modeRead.id, { kind: "number", value: 1 });
    worklist.drain();
    const compilesBeforeDeopt = compileSpy.mock.calls.length;
    expect(compilesBeforeDeopt).toBeGreaterThanOrEqual(2);

    let violation: SpeculationViolation | undefined;
    try {
      interpreter.execute();
    } catch (e) {
      if (!(e instanceof SpeculationViolation)) throw e;
      violation = e;
    }
    expect(violation).toBeDefined();

    worklist.widenGuard(violation!.nodeId);
    worklist.drain();

    const unit = worklist.topology.unitOfNode(modeRead.id)!;
    const ctx = worklist.specContextFor(unit);
    // Lineage-precise: only the load-bearing const assumption was pruned.
    // Under whole-chain reset (the widenFullChain branch), ctx === ROOT.
    expect(ctx).not.toBe(ROOT_CONTEXT);
    expect(findAssumption(ctx, constExprHandle, modeRead.id)).toBeUndefined();
    expect(findAssumption(ctx, typeExprHandle, modeRead.id)).toBeDefined();

    // The pruned context `[typeExprHandle@modeRead]` was never active pre-
    // deopt, but once the const narrowing is gone the remaining speculative
    // inputs are backend-irrelevant, so jitAnalysis can reuse the already-
    // built sibling artifact instead of recompiling.
    expect(compileSpy.mock.calls.length).toBe(compilesBeforeDeopt);

    // The recompile produced a guard-free IR: under [typeExprHandle@modeRead]
    // (no const narrowing in chain), speculativeConditionTruth returns
    // undefined, so visitIfStmt takes the generic branch-emission path.
    const currentProgram = (interpreter as unknown as { program: typeof program }).program;
    expect(hasOpcode(currentProgram, OpCodes.GUARD_TRUTHY)).toBe(false);
  });

  test("DCE ratio: dead arm with N statements drops ~N opcodes", () => {
    // Empirical baseline for the silver-bullet claim. With observation pinning
    // mode, the else arm's 6 assignments all vanish from IR. Else-arm RHSs
    // depend on `mode` so static const-folding can't collapse them — that
    // would shrink the baseline and defeat the DCE measurement.
    const code = `
def hot(mode):
    y = mode
    if y > 0:
        return 1
    else:
        a = mode + 100
        b = mode + 200
        c = mode + 300
        d = mode + 400
        e = mode + 500
        f = mode + 600
        return a + b + c + d + e + f
`;
    // Speculative compile (with observation).
    const { ast, environments, worklist } = build(code);
    const fn = ast.statements[0] as StmtNS.FunctionDef;
    const yAssign = fn.body[0] as StmtNS.Assign;
    const modeRead = yAssign.value as ExprNS.Variable;
    worklist.observe(runtimeWriteAnalysis, modeRead.id, { kind: "number", value: 1 });
    const { program: speculative } = compile(ast, environments, worklist);

    // Static compile (no observation).
    const { ast: ast2, environments: env2, worklist: wl2 } = build(code);
    const { program: staticProgram } = compile(ast2, env2, wl2);

    const opCount = (p: typeof speculative) =>
      p.functions.reduce((sum, fn) => sum + fn.count, 0);
    const ratio = opCount(speculative) / opCount(staticProgram);
    // 6 assignments + a 5-arg sum + return ≈ 25+ opcodes eliminated, vs
    // baseline of ~40. Expect <70% — leaves margin for opcode-counting drift.
    expect(ratio).toBeLessThan(0.7);
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
  // worklist observation-translator level: observations arriving in swapped
  // orders converge on the same canonical Context, and the fact-store holds
  // a single cell per (analysis, canonical-context, key).

  test("observations in swapped arrival order produce ref-equal spec contexts", () => {
    const code = `
def hot(x, y):
    return x + y
`;

    // Worklist A: observe x, then y.
    resetNodeIds();
    const { ast: astA, worklist: wlA } = build(code);
    const fnA = astA.statements[0] as StmtNS.FunctionDef;
    const returnA = fnA.body[0] as StmtNS.Return;
    const binA = returnA.value as ExprNS.Binary;
    const xReadA = binA.left as ExprNS.Variable;
    const yReadA = binA.right as ExprNS.Variable;
    wlA.observe(runtimeWriteAnalysis, xReadA.id, { kind: "number", value: 5 });
    wlA.observe(runtimeWriteAnalysis, yReadA.id, { kind: "number", value: 10 });
    const unitA = wlA.topology.unitOfNode(xReadA.id)!;
    const ctxA = wlA.specContextFor(unitA);

    // Worklist B: observe y, then x (swapped).
    resetNodeIds();
    const { ast: astB, worklist: wlB } = build(code);
    const fnB = astB.statements[0] as StmtNS.FunctionDef;
    const returnB = fnB.body[0] as StmtNS.Return;
    const binB = returnB.value as ExprNS.Binary;
    const xReadB = binB.left as ExprNS.Variable;
    const yReadB = binB.right as ExprNS.Variable;

    // Sanity: resetNodeIds() gives identical node IDs across parses.
    expect(xReadB.id).toBe(xReadA.id);
    expect(yReadB.id).toBe(yReadA.id);

    wlB.observe(runtimeWriteAnalysis, yReadB.id, { kind: "number", value: 10 });
    wlB.observe(runtimeWriteAnalysis, xReadB.id, { kind: "number", value: 5 });
    const unitB = wlB.topology.unitOfNode(xReadB.id)!;
    const ctxB = wlB.specContextFor(unitB);

    // Not vacuous: both observations landed, so the context is non-ROOT.
    expect(ctxA).not.toBe(ROOT_CONTEXT);
    expect(ctxB).not.toBe(ROOT_CONTEXT);
    // The payoff: module-scoped interner + canonical chain order ⇒ identity.
    expect(ctxA).toBe(ctxB);
  });

  test("fact-store dedup: a single canonical context holds one cell, not two", () => {
    const code = `
def hot(x, y):
    return x + y
`;
    resetNodeIds();
    const { ast, worklist } = build(code);
    const fn = ast.statements[0] as StmtNS.FunctionDef;
    const ret = fn.body[0] as StmtNS.Return;
    const bin = ret.value as ExprNS.Binary;
    const xRead = bin.left as ExprNS.Variable;
    const yRead = bin.right as ExprNS.Variable;

    worklist.observe(runtimeWriteAnalysis, xRead.id, { kind: "number", value: 5 });
    worklist.observe(runtimeWriteAnalysis, yRead.id, { kind: "number", value: 10 });
    const ctxForward = worklist.specContextFor(worklist.topology.unitOfNode(xRead.id)!);

    // Re-observe the same values. Under canonical interning the context does
    // not shift (the translator's valueEqual check skips the extend) and no
    // new fact-store cell is allocated.
    const xBlock = worklist.topology.blockOfNode(xRead.id)!;
    const cellsBefore = worklist.readAll(typeAnalysis.env, ctxForward).size;
    worklist.observe(runtimeWriteAnalysis, xRead.id, { kind: "number", value: 5 });
    worklist.observe(runtimeWriteAnalysis, yRead.id, { kind: "number", value: 10 });
    const cellsAfter = worklist.readAll(typeAnalysis.env, ctxForward).size;

    expect(cellsAfter).toBe(cellsBefore);
    // And the narrowed fact is present under exactly the canonical context —
    // the env cell is the one the Kildall driver writes directly; `.facts`
    // is populated as its paired side effect.
    expect(worklist.tryRead(typeAnalysis.env, xBlock, ctxForward)).toBeDefined();
  });
});
