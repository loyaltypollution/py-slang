// CSE JIT regression tests for the Symptom-1 bug and unknown-kind fallback.
//
// These exercise the post-refactor JitHooks surface
// (`dispatchCall` / `dispatchReturn`) via a minimal harness that mirrors
// `PyCseJitEvaluator.evaluateChunk` without the conductor dependency —
// stdout is captured into an in-memory buffer.

import { Context } from "../../../engines/cse/context";
import type { JitHooks } from "../../../engines/cse/context";
import { evaluate } from "../../../engines/cse/interpreter";
import { parse } from "../../../parser/parser-adapter";
import { analyzeWithEnvironments } from "../../../resolver";
import math from "../../../stdlib/math";
import memo from "../../../stdlib/memo";
import misc from "../../../stdlib/misc";
import { makeJitObservers, specializedBodyFor } from "../../../specialization";
import { DEFAULT_PASSES, DEFAULT_TRANSFORMS } from "../../../specialization/defaults";
import { Worklist } from "../../../specialization/framework/worklist";
import { memoizationRule } from "../../../specialization/transforms/memoization";

const CSE_JIT_TRANSFORMS = DEFAULT_TRANSFORMS.filter(r => r !== memoizationRule);

async function runCseJit(code: string): Promise<string[]> {
  const script = code + "\n";
  const ast = parse(script);
  const { errors, environments } = analyzeWithEnvironments(ast, script, 3, [misc, math, memo]);
  if (errors.length > 0) throw errors[0];

  const worklist = new Worklist(ast, environments, DEFAULT_PASSES, undefined, CSE_JIT_TRANSFORMS);
  worklist.drain();

  const observers = makeJitObservers(worklist);
  const jitHooks: JitHooks = {
    rootScope: ast,
    dispatchCall: (scopeId, args) => {
      observers.observeScopeCall(scopeId);
      const unit = worklist.topology.unitOfFunctionId(scopeId);
      if (unit === undefined) return undefined;
      for (let i = 0; i < args.length; i++) {
        observers.observeParamEntry(scopeId, i, args[i]);
      }
      return specializedBodyFor(unit, observers.currentChainFor(scopeId), worklist.topology);
    },
    dispatchReturn: (scopeId, value) => {
      observers.observeScopeReturn(scopeId, value);
    },
  };

  const captured: string[] = [];
  const context = new Context();
  const outStream = new WritableStream<string>({
    write: chunk => { captured.push(chunk); },
  });
  const errStream = new WritableStream<any>({ write: () => {} });
  const inStream = new ReadableStream<string>({});
  context.streams = {
    initialised: true,
    stdout: { stream: outStream, writer: outStream.getWriter() },
    stderr: { stream: errStream, writer: errStream.getWriter() },
    stdin: { stream: inStream, reader: inStream.getReader() },
  };
  context.jitHooks = jitHooks;
  for (const group of [misc, math, memo]) {
    for (const [name, value] of group.builtins) {
      context.nativeStorage.builtins.set(name, value);
    }
  }

  try {
    await evaluate("", ast, context, { variant: 3, groups: [] });
    worklist.drain();
  } finally {
    context.jitHooks = undefined;
  }

  return captured;
}

describe("CSE JIT regression: Symptom 1 (sign-refined speculation must not mis-dispatch)", () => {
  // Original bug: a hot loop of `f(0, 1)` extended the chain with x:INT_ZERO,
  // y:INT_POS. SVML compiled a pruned body under that chain and emitted a
  // guard that only checked `is-a-number`, so `f(5, 1)` slipped through and
  // returned 5. CSE resolves bodies live-per-call via `specializedBodyFor`
  // under the post-param-observation chain — the observation corrects the
  // chain before dispatch, so this call must return 3.
  test("f(5,1) after f(0,1) hot loop returns 3", async () => {
    const out = await runCseJit(`
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
    // The hot loop prints nothing; only `print(f(5,1))` lands output.
    // Under Symptom 1 this would have been "5" — it must be "3".
    expect(out.join("")).toBe("3");
  });

  // Companion: the specialized-branch case must still print 5 without
  // regressing. After the hot loop the dispatched body is pruned for
  // x<y=true; passing (0, 1) again must keep returning 5.
  test("f(0,1) after f(0,1) hot loop still returns 5", async () => {
    const out = await runCseJit(`
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

describe("CSE JIT: cross-type dispatch stays correct", () => {
  // After a hot loop observing x:INT_POS, a call with a different kind
  // (bool) must dispatch correctly. Bool is runtime-distinguishable from
  // int via `classifyRawValue`, and `paramTypeNarrowing.lift` produces a
  // distinct TypeLattice value — the observation corrects the chain before
  // `specializedBodyFor` reads it. No V3-style prune path needed on CSE
  // because body selection is live-per-call.
  test("bool arg after int hot loop takes the correct branch", async () => {
    const out = await runCseJit(`
def h(x):
    if x:
        return 1
    else:
        return 0

i = 0
while i < 20:
    h(5)
    i = i + 1
print(h(False))
print(h(7))
print(h(0))
`);
    // pyslang's print writes values without trailing newlines through this
    // stream, so the three prints concatenate. h(False)→0, h(7)→1, h(0)→0.
    expect(out.join("")).toBe("010");
  });
});
