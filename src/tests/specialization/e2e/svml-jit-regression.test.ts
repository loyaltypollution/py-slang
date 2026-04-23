// SVML JIT regression test for the Symptom 1 bug that motivated the V2
// collapse. Mirrors `PySvmlJitEvaluator.evaluateChunk` (V2) without the
// conductor dependency, capturing stdout via `sendOutput`.

import { SVMLCompiler } from "../../../engines/svml/svml-compiler";
import { SVMLInterpreter } from "../../../engines/svml/svml-interpreter";
import { parse } from "../../../parser/parser-adapter";
import { analyzeWithEnvironments } from "../../../resolver";
import math from "../../../stdlib/math";
import memo from "../../../stdlib/memo";
import misc from "../../../stdlib/misc";
import { makeDfaQuery, makeJitObservers } from "../../../specialization";
import { createDefaultWorklist } from "../../../specialization/defaults";
import { specializedBodyFor } from "../../../specialization/speculative-clone";

async function runSvmlJit(code: string): Promise<string[]> {
  const script = code + "\n";
  const ast = parse(script);
  const { errors, environments } = analyzeWithEnvironments(ast, script, 4, [misc, math, memo]);
  if (errors.length > 0) throw errors[0];

  const worklist = createDefaultWorklist(ast, environments);
  worklist.drain();

  const compiler = SVMLCompiler.fromProgramUnit(
    ast,
    environments,
    makeDfaQuery(
      worklist.topology,
      nodeId => worklist.futureDispatchChainForNode(nodeId),
      unit => worklist.futureDispatchChainFor(unit),
    ),
    worklist.registry,
  );
  const program = compiler.compileProgram(ast);

  const captured: string[] = [];
  const observers = makeJitObservers(worklist);
  const interpreter = new SVMLInterpreter(program, {
    sendOutput: msg => { captured.push(msg); },
    dispatchCall: (scopeId, args) => {
      observers.observeScopeCall(scopeId);
      const unit = worklist.topology.unitOfFunctionId(scopeId);
      if (unit === undefined) return undefined;
      for (let i = 0; i < args.length; i++) {
        observers.observeParamEntry(scopeId, i, args[i]);
      }
      worklist.sweepTransforms();
      const chain = observers.currentChainFor(scopeId);
      const specBody = specializedBodyFor(unit, chain, worklist.topology);
      if (specBody === undefined) return undefined;
      return compiler.compileFunction(unit, specBody);
    },
    dispatchReturn: (scopeId, value) => observers.observeScopeReturn(scopeId, value),
  });

  interpreter.execute();
  return captured;
}

describe("SVML JIT regression: Symptom 1 (precision drift bug, original motivator)", () => {
  // The bug as originally reported: hot-looping `f(0, 1)` extended the
  // chain with x:INT_ZERO, y:INT_POS. SVML compiled a pruned body (else
  // branch dead, just `return 5`) and emitted a GUARD_KIND that only
  // checked "is-a-number" — dropping sign refinement. `f(5, 1)` passed
  // the coarse guard, executed the pruned body, and printed 5. V2 fixes
  // this by structure: dispatchCall compiles live against the post-
  // observation chain, which for `f(5, 1)` reflects x:INT_POS and no
  // prune fires. No guards, no precision drift surface.
  test("f(5,1) after f(0,1) hot loop prints 3", async () => {
    const out = await runSvmlJit(`
def f(x, y):
    if x < y:
        return 5
    else:
        return 3

i = 0
while i < 100:
    f(0, 1)
    i = i + 1
print(f(5, 1))
`);
    expect(out.join("")).toBe("3");
  });

  test("f(0,1) after f(0,1) hot loop still prints 5", async () => {
    const out = await runSvmlJit(`
def f(x, y):
    if x < y:
        return 5
    else:
        return 3

i = 0
while i < 100:
    f(0, 1)
    i = i + 1
print(f(0, 1))
`);
    expect(out.join("")).toBe("5");
  });

});
