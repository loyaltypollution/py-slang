// JIT dispatch correctness under speculation chains: the compiled body served
// to a runtime call must match the chain inferred from that call's arguments,
// not a stale chain from prior hot-loop observations.

import { clearMemoCache } from "../../runtime/memo";
import { runCseJit, runSvmlJit } from "./harness/jit-runners";

const SIGN_REFINED = `
def f(x, y):
    if x < y:
        return 5
    else:
        return 3

i = 0
while i < 100:
    f(0, 1)
    i = i + 1
`;

const BACKENDS = [
  ["svml", runSvmlJit],
  ["cse", runCseJit],
] as const;

// Hot-looping `f(0, 1)` extends the chain with x:INT_ZERO, y:INT_POS. A naive
// compile-once strategy emits a pruned body guarded only by is-a-number, so a
// later `f(5, 1)` slips through and returns 5 instead of 3. Fix: dispatchCall
// compiles live against the post-observation chain.
describe.each(BACKENDS)("%s JIT: sign-refined speculation", (_name, run) => {
  test("f(5,1) after f(0,1) hot loop -> 3", async () => {
    const out = await run(SIGN_REFINED + "print(f(5, 1))\n");
    expect(out.join("")).toBe("3");
  });

  test("f(0,1) after f(0,1) hot loop still -> 5", async () => {
    const out = await run(SIGN_REFINED + "print(f(0, 1))\n");
    expect(out.join("")).toBe("5");
  });
});

// Bool is runtime-distinguishable from int via classifyRawValue;
// paramTypeNarrowing.lift yields a distinct TypeLattice value, so the
// observation corrects the chain before body selection. pyslang `print`
// writes without trailing newlines → outputs concatenate.
describe("cse JIT: cross-type dispatch stays correct", () => {
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
    expect(out.join("")).toBe("010");
  });
});

// Specialization hazard: a recursive call can dispatch onto the caller's
// specialized body and escape its speculative narrowing. Here the ROOT body
// keeps `if n<0: print(...)`; the specialized body has it spliced out under
// an x:non-neg narrowing. A recursive `fib(-1)` call must not silently
// take the specialized body.
describe("recursive call escaping caller speculation", () => {
  beforeEach(clearMemoCache);

  test("fib with n<0 side effect fires 33 times (matches non-JIT ground truth)", async () => {
    const outputs = await runSvmlJit(`
def fib(n):
    if n < 0:
        print("side effect")
    if n < 2:
        return n
    fib(-1)
    return fib(n - 1) + fib(n - 2)

print(fib(8))
`);
    expect(outputs.filter(o => o === "side effect").length).toBe(33);
  });
});

// Regression for the saturation short-circuit fix in runtime-analyses.ts.
// Two distinct POS values saturate the param-channel shadow cell at
// (chain, paramKey(f,0)) to ⊤. The subsequent NEG call must still publish so
// `handleObservationForSpec` replaces the POS narrowing with NEG. Before the
// fix, publish was skipped → POS-specialized body served to the NEG call.
describe("saturated observation channel still prunes on conflicting type", () => {
  beforeEach(clearMemoCache);

  test("param channel", async () => {
    const outputs = await runSvmlJit(`
def f(n):
    if n < 0:
        print("neg")
    else:
        print("pos")

f(5)
f(7)
f(-1)
`);
    expect(outputs).toEqual(["pos", "pos", "neg"]);
  });

  test("return channel", async () => {
    const outputs = await runSvmlJit(`
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
`);
    expect(outputs).toEqual(["pos", "pos", "neg"]);
  });
});
