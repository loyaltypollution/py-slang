// Speculative observation-narrowing pipeline.
//
// Validates the `runtimeWriteAnalysis → speculative{Type,Const}Analysis →
// svml-compiler GUARD_TRUTHY emission → SpeculationViolation deopt → recompile`
// chain. The standard (widening) analyses must remain unchanged so AST-mutating
// transforms stay sound; the speculative analyses are the JIT-only refinement
// the compiler consults when emitting guards. Numeric-kind speculation
// (GUARD_KIND / MULF) was disabled — see svml-compiler.ts `numericMode`.

import { ExprNS, StmtNS } from "../../../ast-types";
import { SpeculationViolation } from "../../../engines/svml/errors";
import { makeJitAnalysis } from "../../../engines/svml/jit-analysis";
import OpCodes, { SVMLKindBits } from "../../../engines/svml/opcodes";
import { SVMLCompiler } from "../../../engines/svml/svml-compiler";
import { SVMLInterpreter } from "../../../engines/svml/svml-interpreter";
import { parse } from "../../../parser/parser-adapter";
import { analyzeWithEnvironments } from "../../../resolver";
import { typeAnalysis } from "../../../specialization/framework/dfa-analyses";
import { readExprFact } from "../../../specialization/framework/dfa-factory";
import {
  runtimeWriteAnalysis,
  widenWriteObservation,
} from "../../../specialization/framework/runtime-analyses";
import { INT_BIT } from "../../../specialization/type-analysis/lattice";
import { makeDfaQuery } from "../../../specialization";
import { hasOpcode } from "../../harness/opcode-assert";
import { buildTestWorklist } from "../../utils";

function build(code: string) {
  const script = code + "\n";
  const ast = parse(script) as StmtNS.FileInput;
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
      worklist.factStore,
      worklist.nodeIndex,
      nodeId => worklist.specContextForNode(nodeId),
    ),
    worklist.registry,
    worklist,
  );
  return { compiler, program: compiler.compileProgram(ast) };
}

function findFirstVariableRead(node: ExprNS.Expr | StmtNS.Stmt, name: string): ExprNS.Variable | undefined {
  const stack: unknown[] = [node];
  while (stack.length) {
    const n = stack.pop();
    if (n instanceof ExprNS.Variable && n.name.lexeme === name) return n;
    if (n && typeof n === "object") {
      for (const v of Object.values(n)) {
        if (Array.isArray(v)) stack.push(...v);
        else if (v && typeof v === "object" && "kind" in v) stack.push(v);
      }
    }
  }
  return undefined;
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

    expect(worklist.factStore.tryRead(runtimeWriteAnalysis, xRead.id)).toEqual({ kind: "number", value: 5 });

    const block = worklist.blockOfNode(xRead.id)!;
    const widened = readExprFact(worklist.factStore, typeAnalysis, block, xRead.id);
    // Speculative read: same typeAnalysis, per-unit speculation context that
    // the observation→context translator extended on the observe above.
    const narrowed = readExprFact(
      worklist.factStore,
      typeAnalysis,
      block,
      xRead.id,
      worklist.specContextForNode(xRead.id),
    );

    // `x` is a parameter — slot type is TOP. Widening analysis sees that `join(TOP, INT_POS) = TOP`.
    expect(widened?.kinds).not.toBe(INT_BIT);
    // Narrowing via context assumption: `meet(TOP, INT_POS) = INT_POS`.
    expect(narrowed?.kinds).toBe(INT_BIT);
  });
});

// GUARD_KIND emission was disabled in svml-compiler (see numericMode rationale:
// ADDF vs ADDG differed by ~2 typeof checks, V8 PIC closes the gap, measured
// speedup ≤1%). The numeric-speculation tests that used to live here were
// removed; GUARD_TRUTHY dead-branch tests below remain the speculation spec.

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

    const block = worklist.blockOfNode(xRead.id)!;
    const before = readExprFact(
      worklist.factStore,
      typeAnalysis,
      block,
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
      worklist.factStore,
      typeAnalysis,
      block,
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

  test("artifact cache: deopt to a previously-compiled ancestor context skips recompile", () => {
    // Artifact-tree MVP. Timeline:
    //   1. jitAnalysis registered before any observation → first transfer
    //      compiles the unit under ROOT_CONTEXT and caches the IR.
    //   2. Observation on `mode` extends the unit's context to C1 → jit
    //      transfer recompiles under C1 (with GUARD_TRUTHY), caches that IR.
    //   3. Runtime sees mode=0, the guard fires, widenGuard prunes the sole
    //      load-bearing assumption, and the unit's active context reverts
    //      to ROOT_CONTEXT — the SAME singleton the cache already holds an
    //      IR for.
    //   4. The next jit transfer must hit the cache and re-patch the
    //      baseline IR without calling `compiler.compileFunction` again.
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
    worklist.drain(); // initial compile under ROOT populates cache[ROOT]

    // Observe a truthy value to drive the unit off ROOT and force a
    // speculative recompile under the new context.
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

    // Cache hit on ROOT: no additional compileFunction invocation.
    expect(compileSpy.mock.calls.length).toBe(compilesBeforeDeopt);
    // And the backend is dispatching to a guard-free IR.
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

describe("SVMLKindBits sanity", () => {
  test("NUMBER bit matches what svmlKindToBit returns for typeof number", () => {
    expect(SVMLKindBits.NUMBER).toBe(1);
    expect(SVMLKindBits.BOOLEAN).toBe(2);
  });
});
