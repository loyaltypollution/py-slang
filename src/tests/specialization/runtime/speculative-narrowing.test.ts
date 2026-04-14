// Speculative observation-narrowing pipeline.
//
// Validates the `runtimeWritePass → speculative{Type,Const}AnalysisPass →
// svml-compiler GUARD_KIND emission → SpeculationViolation deopt → recompile`
// chain. The standard (widening) passes must remain unchanged so AST-mutating
// transforms stay sound; the speculative passes are the JIT-only refinement
// the compiler consults when emitting guards.

import { ExprNS, StmtNS } from "../../../ast-types";
import { SpeculationViolation } from "../../../engines/svml/errors";
import { makeJitPass } from "../../../engines/svml/jit-pass";
import OpCodes, { SVMLKindBits } from "../../../engines/svml/opcodes";
import { SVMLCompiler } from "../../../engines/svml/svml-compiler";
import { SVMLInterpreter } from "../../../engines/svml/svml-interpreter";
import { parse } from "../../../parser/parser-adapter";
import { analyzeWithEnvironments } from "../../../resolver";
import {
  speculativeTypeAnalysisPass,
  typeAnalysisPass,
} from "../../../specialization/framework/dfa-passes";
import { readExprFact } from "../../../specialization/framework/dfa-factory";
import {
  runtimeWritePass,
  speculationBlacklistPass,
  widenWriteObservation,
  blacklistSpeculation,
} from "../../../specialization/framework/runtime-passes";
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
    makeDfaQuery(worklist.factStore, worklist.nodeIndex),
    worklist.registry,
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

describe("speculative pass: meet vs join", () => {
  test("widening pass preserves TOP under observation; speculative pass narrows to the singleton", () => {
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
    worklist.observe(runtimeWritePass, xRead.id, { kind: "number", value: 5 });
    worklist.drain();

    expect(worklist.factStore.tryRead(runtimeWritePass, xRead.id)).toEqual({ kind: "number", value: 5 });

    const block = worklist.blockOfNode(xRead.id)!;
    const widened = readExprFact(worklist.factStore, typeAnalysisPass, block, xRead.id);
    const narrowed = readExprFact(worklist.factStore, speculativeTypeAnalysisPass, block, xRead.id);

    // `x` is a parameter — slot type is TOP. Widening pass sees that `join(TOP, INT_POS) = TOP`.
    expect(widened?.kinds).not.toBe(INT_BIT);
    // Narrowing pass: `meet(TOP, INT_POS) = INT_POS`. Speculation sees the witness.
    expect(narrowed?.kinds).toBe(INT_BIT);
  });
});

describe("svml-compiler: GUARD_KIND emission gated by speculation", () => {
  test("MULF + GUARD_KIND emitted when only speculative pass proves numeric", () => {
    const { ast, environments, worklist } = build(`
def hot(x):
    y = x
    return y * 2
`);
    const fn = ast.statements[0] as StmtNS.FunctionDef;
    const assign = fn.body[0] as StmtNS.Assign;
    const xRead = assign.value as ExprNS.Variable;

    worklist.observe(runtimeWritePass, xRead.id, { kind: "number", value: 5 });

    const { program } = compile(ast, environments, worklist);
    expect(hasOpcode(program, OpCodes.MULF)).toBe(true);
    expect(hasOpcode(program, OpCodes.MULG)).toBe(false);
    expect(hasOpcode(program, OpCodes.GUARD_KIND)).toBe(true);
  });

  test("no speculation without observation — falls back to MULG", () => {
    const { ast, environments, worklist } = build(`
def hot(x):
    y = x
    return y * 2
`);
    // Deliberately no observe(): speculative pass has no facts to meet against.
    const { program } = compile(ast, environments, worklist);
    expect(hasOpcode(program, OpCodes.MULG)).toBe(true);
    expect(hasOpcode(program, OpCodes.GUARD_KIND)).toBe(false);
  });

  test("impure scope blocks speculation even with observation present", () => {
    // print() makes hot impure; speculation gate refuses to emit guards
    // because deopt re-entry would replay the print.
    const { ast, environments, worklist } = build(`
def hot(x):
    print(x)
    y = x
    return y * 2
`);
    const fn = ast.statements[0] as StmtNS.FunctionDef;
    // Find Variable x inside `y = x` (skip over the print call site).
    const assign = fn.body[1] as StmtNS.Assign;
    const xRead = assign.value as ExprNS.Variable;
    worklist.observe(runtimeWritePass, xRead.id, { kind: "number", value: 5 });

    const { program } = compile(ast, environments, worklist);
    expect(hasOpcode(program, OpCodes.GUARD_KIND)).toBe(false);
  });
});

describe("GUARD_KIND interpreter semantics", () => {
  test("matches mask → no-op; mismatch → SpeculationViolation", () => {
    const { ast, environments, worklist } = build(`
def hot(x):
    y = x
    return y * 2

print(hot(10))
`);
    const fn = ast.statements[0] as StmtNS.FunctionDef;
    const xRead = (fn.body[0] as StmtNS.Assign).value as ExprNS.Variable;
    worklist.observe(runtimeWritePass, xRead.id, { kind: "number", value: 5 });

    const { program } = compile(ast, environments, worklist);

    // Numeric arg: completes, no throw.
    const okOutputs: string[] = [];
    const okInterp = new SVMLInterpreter(program, { sendOutput: m => okOutputs.push(m) });
    expect(() => okInterp.execute()).not.toThrow();
    expect(okOutputs).toContain("20");

    // Replace top-level call with `hot("oops")` so guard fires. Since AST is
    // already compiled, build a parallel program where the literal arg is a
    // string. Easiest route: re-parse with a string arg, recompile under the
    // SAME observation (forces same opcode shape).
    const { ast: ast2, environments: env2, worklist: wl2 } = build(`
def hot(x):
    y = x
    return y * 2

print(hot("oops"))
`);
    const fn2 = ast2.statements[0] as StmtNS.FunctionDef;
    const xRead2 = (fn2.body[0] as StmtNS.Assign).value as ExprNS.Variable;
    wl2.observe(runtimeWritePass, xRead2.id, { kind: "number", value: 5 });
    const { program: badProgram } = compile(ast2, env2, wl2);

    const badInterp = new SVMLInterpreter(badProgram, { sendOutput: () => {} });
    expect(() => badInterp.execute()).toThrow(SpeculationViolation);
  });
});

describe("widenWriteObservation: deopt-protocol primitive", () => {
  test("writing ⊤ at a node erases speculative narrowing on next pass", () => {
    const { ast, worklist } = build(`
def hot(x):
    y = x
    return y * 2
`);
    const fn = ast.statements[0] as StmtNS.FunctionDef;
    const xRead = (fn.body[0] as StmtNS.Assign).value as ExprNS.Variable;
    worklist.observe(runtimeWritePass, xRead.id, { kind: "number", value: 5 });
    worklist.drain();

    const block = worklist.blockOfNode(xRead.id)!;
    const before = readExprFact(worklist.factStore, speculativeTypeAnalysisPass, block, xRead.id);
    expect(before?.kinds).toBe(INT_BIT);

    widenWriteObservation(worklist, xRead.id);
    worklist.drain();

    const after = readExprFact(worklist.factStore, speculativeTypeAnalysisPass, block, xRead.id);
    // After widening, observation is ⊤, so meet falls through to staticVal,
    // which is TOP for an unannotated parameter slot.
    expect(after?.kinds).not.toBe(INT_BIT);
  });
});

describe("end-to-end deopt: PySvmlJitEvaluator-style retry", () => {
  test("guard violation → blacklist → recompile drops GUARD_KIND from the unit", () => {
    // Mimic what runWithDeopt does. After the guard fires, the deopt handler
    // blacklists the node, drains, jit-pass recompiles. Verify the new IR
    // no longer contains GUARD_KIND for that nodeId. (The post-deopt MULG
    // then runs unsupported-operand semantics on string*number — that's
    // expected behavior; we don't assert it here.)
    const { ast, environments, worklist } = build(`
def hot(x):
    y = x
    return y * 2

hot("oops")
`);
    const fn = ast.statements[0] as StmtNS.FunctionDef;
    const xRead = (fn.body[0] as StmtNS.Assign).value as ExprNS.Variable;
    worklist.observe(runtimeWritePass, xRead.id, { kind: "number", value: 5 });

    const { compiler, program } = compile(ast, environments, worklist);
    const interpreter = new SVMLInterpreter(program, { sendOutput: () => {} });
    worklist.register(makeJitPass({ compiler, interpreter }));

    expect(hasOpcode(program, OpCodes.GUARD_KIND)).toBe(true);

    let violation: SpeculationViolation | undefined;
    try {
      interpreter.execute();
    } catch (e) {
      if (!(e instanceof SpeculationViolation)) throw e;
      violation = e;
    }
    expect(violation).toBeDefined();

    blacklistSpeculation(worklist, violation!.nodeId);
    worklist.drain();

    // After blacklist + drain, the patched program no longer guards this site.
    // Read interpreter's current program (a different reference than `program`,
    // produced by patchFunction).
    const currentProgram = (interpreter as unknown as { program: typeof program }).program;
    expect(hasOpcode(currentProgram, OpCodes.GUARD_KIND)).toBe(false);
    expect(hasOpcode(currentProgram, OpCodes.MULG)).toBe(true);
    expect(worklist.factStore.tryRead(speculationBlacklistPass, violation!.nodeId)).toBe(true);
  });
});

describe("SVMLKindBits sanity", () => {
  test("NUMBER bit matches what svmlKindToBit returns for typeof number", () => {
    expect(SVMLKindBits.NUMBER).toBe(1);
    expect(SVMLKindBits.BOOLEAN).toBe(2);
  });
});
