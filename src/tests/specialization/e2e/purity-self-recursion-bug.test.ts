// Repro: JIT under-counts side effects for a recursive function whose
// recursive call escapes the speculative narrowing of its caller.
//
// Program:
//   def fib(n):
//       if n < 0: print("side effect")
//       if n < 2: return n
//       fib(-1)
//       return fib(n-1) + fib(n-2)
//   print(fib(8))
//
// Ground truth (naive / no-JIT SVML): 33 "side effect" lines, fib(8)=21.
// JIT result: 7 "side effect" lines, fib(8)=23. Both count and value wrong.
//
// Mechanism (observed via body dump):
//   ROOT body keeps `if n<0: print(...)`.
//   Specialized body has that If spliced out by dead-branch under a paramType
//   narrowing that proves `n<0` dead.
//   The recursive `fib(-1)` call ends up dispatched onto the specialized
//   body, so the `print` is silently elided AND -1 flows through a body that
//   assumed non-negative input, which corrupts the arithmetic too.
//
// This is NOT a purity-analysis bug — memo cache is empty. Purity's
// self-recursion shortcut is a separate latent issue but not the cause here.

import { ExprNS, StmtNS } from "../../../ast-types";
import { SVMLCompiler } from "../../../engines/svml/svml-compiler";
import { SVMLInterpreter } from "../../../engines/svml/svml-interpreter";
import { parse } from "../../../parser/parser-adapter";
import { analyzeWithEnvironments } from "../../../resolver";
import math from "../../../stdlib/math";
import memo from "../../../stdlib/memo";
import misc from "../../../stdlib/misc";
import { clearMemoCache } from "../../../runtime/memo";
import { makeDfaQuery, makeJitObservers } from "../../../specialization";
import { createDefaultWorklist } from "../../../specialization/defaults";
import { specializedBodyFor } from "../../../specialization/speculative-clone";

async function runWithoutJit(code: string): Promise<{ outputs: string[] }> {
  const script = code + "\n";
  const ast = parse(script) as StmtNS.FileInput;
  const { errors, environments } = analyzeWithEnvironments(ast, script, 4, [misc, math, memo]);
  if (errors.length > 0) throw errors[0];
  const worklist = createDefaultWorklist(ast, environments);
  const compiler = SVMLCompiler.fromProgramUnit(
    ast, environments,
    makeDfaQuery(
      worklist.topology,
      id => worklist.futureDispatchChainForNode(id),
      u => worklist.futureDispatchChainFor(u),
    ),
    worklist.registry,
  );
  const program = compiler.compileProgram(ast);
  const outputs: string[] = [];
  const interp = new SVMLInterpreter(program, { sendOutput: m => outputs.push(m) });
  await interp.execute();
  return { outputs };
}

async function runWithJit(code: string): Promise<{ outputs: string[] }> {
  const script = code + "\n";
  const ast = parse(script) as StmtNS.FileInput;
  const { errors, environments } = analyzeWithEnvironments(ast, script, 4, [misc, math, memo]);
  if (errors.length > 0) throw errors[0];
  const worklist = createDefaultWorklist(ast, environments);
  worklist.drain();
  const compiler = SVMLCompiler.fromProgramUnit(
    ast, environments,
    makeDfaQuery(
      worklist.topology,
      id => worklist.futureDispatchChainForNode(id),
      u => worklist.futureDispatchChainFor(u),
    ),
    worklist.registry,
  );
  const program = compiler.compileProgram(ast);
  const outputs: string[] = [];
  const observers = makeJitObservers(worklist);
  const interp = new SVMLInterpreter(program, {
    sendOutput: m => outputs.push(m),
    dispatchCall: (scopeId, args) => {
      observers.observeScopeCall(scopeId);
      const unit = worklist.topology.unitOfFunctionId(scopeId);
      if (unit === undefined) return undefined;
      for (let i = 0; i < args.length; i++) observers.observeParamEntry(scopeId, i, args[i]);
      worklist.sweepTransforms();
      const chain = observers.currentChainFor(scopeId);
      const specBody = specializedBodyFor(unit, chain, worklist.topology);
      if (specBody === undefined) return undefined;
      return compiler.compileFunction(unit, specBody);
    },
    dispatchReturn: (scopeId, value) => observers.observeScopeReturn(scopeId, value),
  });
  await interp.execute();
  // Silence unused warning.
  void ExprNS;
  return { outputs };
}

describe("JIT dispatch serves specialized body to recursive call that escapes its speculation", () => {
  beforeEach(clearMemoCache);

  const program = `
def fib(n):
    if n < 0:
        print("side effect")
    if n < 2:
        return n
    fib(-1)
    return fib(n - 1) + fib(n - 2)

print(fib(8))
`;

  test("no-JIT baseline: 33 side effects", async () => {
    const { outputs } = await runWithoutJit(program);
    expect(outputs.filter(o => o === "side effect").length).toBe(33);
  });

  test("JIT matches no-JIT", async () => {
    const { outputs } = await runWithJit(program);
    expect(outputs.filter(o => o === "side effect").length).toBe(33);
  });
});

// Targeted regression for the saturation short-circuit fix in
// runtime-analyses.ts. Two distinct POS values saturate the param-channel
// shadow cell at (chain, paramKey(f,0)) to ⊤. The subsequent NEG call
// must still publish so that `handleObservationForSpec` replaces the
// POS paramType narrowing on the chain with NEG. Before the fix,
// publish was skipped and the POS-specialized body (else-branch only)
// was served to the NEG call — "pos" instead of "neg".
describe("saturated observation channel still prunes chain on conflicting type", () => {
  beforeEach(clearMemoCache);

  const program = `
def f(n):
    if n < 0:
        print("neg")
    else:
        print("pos")

f(5)
f(7)
f(-1)
`;

  test("no-JIT baseline", async () => {
    const { outputs } = await runWithoutJit(program);
    expect(outputs).toEqual(["pos", "pos", "neg"]);
  });

  test("JIT matches no-JIT after saturation", async () => {
    const { outputs } = await runWithJit(program);
    expect(outputs).toEqual(["pos", "pos", "neg"]);
  });
});

// Sibling case on runtimeReturnChannel: a callee that returns two
// distinct POS values then a NEG value saturates the return-shadow cell,
// then a later caller branches on the return value. Before the fix, the
// post-saturation NEG return would be silently dropped and the caller's
// return-kind narrowing would stay POS.
describe("saturated return channel still prunes on conflicting return type", () => {
  beforeEach(clearMemoCache);

  const program = `
def g(n):
    return n

def caller(n):
    r = g(n)
    if r < 0:
        print("neg")
    else:
        print("pos")

caller(5)
caller(7)
caller(-1)
`;

  test("no-JIT baseline", async () => {
    const { outputs } = await runWithoutJit(program);
    expect(outputs).toEqual(["pos", "pos", "neg"]);
  });

  test("JIT matches no-JIT after return-channel saturation", async () => {
    const { outputs } = await runWithJit(program);
    expect(outputs).toEqual(["pos", "pos", "neg"]);
  });
});
