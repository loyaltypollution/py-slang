/**
 * Tests for the intraprocedural MOD-dataflow purity analysis.
 * Each case supplies source code and the expected purity of a named fn.
 */

import { StmtNS } from "../../ast-types";
import { purityFunctionAnalysis } from "../../specialization/analysis/purity/analysis";
import { runtimeParamChannel } from "../../specialization/observation/runtime-analyses";
import { paramKey } from "../../specialization/narrowing-policy/param-key";
import { ROOT_CONTEXT } from "../../specialization/assumption/chain";
import { setupAndDrain } from "./harness/compile-pipelines";

function purityOf(code: string, fnName: string): boolean | undefined {
  const { ast, worklist } = setupAndDrain(code);
  for (const stmt of ast.statements) {
    if (stmt instanceof StmtNS.FunctionDef && stmt.name.lexeme === fnName) {
      return worklist.tryRead(purityFunctionAnalysis, worklist.locate.functionById(stmt.id)!, ROOT_CONTEXT);
    }
  }
  throw new Error(`FunctionDef ${fnName} not found`);
}

type Case = [label: string, code: string, fn: string, expected: boolean];

function runCases(cases: Case[]): void {
  test.each(cases)("%s", (_label, code, fn, expected) => {
    expect(purityOf(code, fn)).toBe(expected);
  });
}

describe("PurityScopeAnalysis — arithmetic, locals, and common impurities", () => {
  runCases([
    ["pure arithmetic body", "def f(x):\n    return x + 1", "f", true],
    ["pure local assign + return", "def f(x):\n    y = x * 2\n    return y", "f", true],
    ["pure ternary", "def f(x):\n    return x if x > 0 else -x", "f", true],
    [
      "pure self-recursive call",
      "def f(x):\n    if x <= 0:\n        return 0\n    return f(x - 1)",
      "f",
      true,
    ],
    // Regression: self-recursion with non-Variable args must not taint.
    [
      "pure double self-recursion (fib)",
      "def fib(n):\n    if n < 2:\n        return n\n    return fib(n - 1) + fib(n - 2)",
      "fib",
      true,
    ],
    [
      "pure with conditional branches",
      "def f(x):\n    if x > 0:\n        return x\n    else:\n        return -x",
      "f",
      true,
    ],
    [
      "pure while loop with local counter",
      "def f(n):\n    i = 0\n    acc = 0\n    while i < n:\n        acc = acc + i\n        i = i + 1\n    return acc",
      "f",
      true,
    ],
    ["impure: user-fn call", "def g(x):\n    return x\ndef f(x):\n    return g(x)", "f", false],
    ["impure: print I/O", "def f(x):\n    return print(x)", "f", false],
    ["impure: global name read", "g = 1\ndef f(x):\n    return x + g", "f", false],
    ["impure: lambda in body", "def f(x):\n    y = lambda z: z\n    return x", "f", false],
    // Closure creation isn't a side effect; nested `g` is never invoked.
    [
      "pure: unused nested pure def",
      "def f(x):\n    def g(y):\n        return y\n    return x",
      "f",
      true,
    ],
    // Escapes an impure closure to the caller.
    [
      "impure: returns impure nested def",
      "def f(x):\n    def g(y):\n        print(y)\n        return y\n    return g",
      "f",
      false,
    ],
    [
      "impure: subscript store via param",
      "def f(xs, i):\n    xs[i] = 1\n    return 0",
      "f",
      false,
    ],
    ["impure: global declaration", "def f(x):\n    global g\n    return x", "f", false],
    ["pure: bare side-effect-free SimpleExpr", "def f(x):\n    x + 1\n    return x", "f", true],
    ["impure: bare impure-call SimpleExpr", "def f(x):\n    print(x)\n    return x", "f", false],
    ["impure: assert", "def f(x):\n    assert x > 0\n    return x", "f", false],
  ]);
});

// Control-flow discriminators: distinct assigns on distinct paths, join after.
describe("PurityScopeAnalysis — CFG joins", () => {
  runCases([
    [
      "branchy local write with merging arms",
      "def f(x):\n    y = 0\n    if x > 0:\n        y = 1\n    else:\n        y = 2\n    return y",
      "f",
      true,
    ],
    [
      "loop-local accumulator",
      "def g(n):\n    s = 0\n    i = 0\n    while i < n:\n        s = s + i\n        i = i + 1\n    return s",
      "g",
      true,
    ],
  ]);
});

describe("PurityScopeAnalysis — whitelisted builtins and subscript reads", () => {
  runCases([
    [
      "whitelisted range in for-iter",
      "def f(n):\n    s = 0\n    for i in range(n):\n        s = s + i\n    return s",
      "f",
      true,
    ],
    ["whitelisted len", "def f(xs):\n    n = len(xs)\n    return n + 1", "f", true],
    ["subscript read of param", "def f(xs, i):\n    return xs[i]", "f", true],
    ["non-whitelisted builtin stays impure", "def f(x):\n    return print(x)", "f", false],
  ]);
});

// Freshness/escape: stores targeting locally-allocated containers stay pure.
describe("PurityScopeAnalysis — freshness", () => {
  runCases([
    [
      "fresh list, local mutate, element return",
      "def f(n):\n    xs = [0, 0]\n    xs[0] = n\n    return xs[0]",
      "f",
      true,
    ],
    ["impure: subscript-store through param", "def f(xs):\n    xs[0] = 1\n    return 0", "f", false],
    [
      "direct alias of fresh list",
      "def f(n):\n    xs = [0]\n    a = xs\n    a[0] = n\n    return a[0]",
      "f",
      true,
    ],
    [
      "fresh list mutated inside for-loop",
      "def f(n):\n    xs = [0, 0]\n    for i in range(n):\n        xs[0] = i\n    return xs[0]",
      "f",
      true,
    ],
    [
      "fresh list populated from param read",
      "def f(xs):\n    ys = [0]\n    ys[0] = xs[0]\n    return ys[0]",
      "f",
      true,
    ],
    // Fresh ∨ Param = Unknown at merge → store on Unknown is impure.
    [
      "impure: freshness widened at merge",
      "def f(flag, ys):\n    if flag:\n        xs = [0]\n    else:\n        xs = ys\n    xs[0] = 1\n    return 0",
      "f",
      false,
    ],
  ]);
});

describe("PurityScopeAnalysis — reachability under speculation", () => {
  // Non-recursive on purpose: self-recursion purity is judged at ROOT, so
  // mixing self-recursion with a chain-pruned impure block would keep purity
  // false at the spec chain regardless of the reachability logic.
  test("impure branch pruned by param-type narrowing flips purity to true", () => {
    const { ast, worklist } = setupAndDrain(`
def hot(x):
    if x <= 0:
        print("no collatz here")
        return -1
    return x * 2
`);
    const fn = ast.statements[0] as StmtNS.FunctionDef;

    expect(worklist.tryRead(purityFunctionAnalysis, worklist.locate.functionById(fn.id)!,ROOT_CONTEXT)).toBe(false);

    worklist.publish(runtimeParamChannel, paramKey(fn.id, 0), { kind: "number", value: 8 }, ROOT_CONTEXT);
    worklist.drain();

    const unit = worklist.locate.functionById(fn.id)!;
    const specCtx = worklist.futureDispatchChainFor(unit);
    expect(specCtx).not.toBe(ROOT_CONTEXT);
    expect(worklist.tryRead(purityFunctionAnalysis, worklist.locate.functionById(fn.id)!,specCtx)).toBe(true);
  });
});

describe("PurityScopeAnalysis — nested closures", () => {
  runCases([
    [
      "pure: nested def called locally",
      "def f(n):\n    def double(x):\n        return x + x\n    return double(n)",
      "f",
      true,
    ],
    // Capture-read is a dependency, not an effect.
    [
      "pure: nested def reads outer capture",
      "def outer(n):\n    def inner(x):\n        return x + n\n    return inner(1)",
      "outer",
      true,
    ],
    [
      "impure: call through impure nested def",
      "def outer(n):\n    def inner(x):\n        print(x)\n        return x\n    return inner(n)",
      "outer",
      false,
    ],
  ]);
});
