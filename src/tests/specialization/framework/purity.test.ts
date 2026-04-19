/**
 * Tests for the intraprocedural MOD-dataflow purity analysis (PurityScopeAnalysis).
 *
 * The analysis runs a fixpoint CFG walk with a block-level `PurityRecord`
 * (mod-set, call-purity, sticky impure flag) and derives `hint.pure` at
 * the exit block. These tests cover parity with the previous syntactic
 * fold plus the capability gains introduced by:
 *   - a whitelist of memo-safe builtins (`range`, `len`, `abs`, …)
 *   - subscript-read treated as pure (previously IMPURE)
 */

import { StmtNS } from "../../../ast-types";
import { parse } from "../../../parser/parser-adapter";
import { analyzeWithEnvironments } from "../../../resolver";
import { Worklist } from "../../../specialization/framework/worklist";
import { purityScopeAnalysis } from "../../../specialization/purity-analysis/analysis";

function purityOf(code: string, fnName: string): boolean | undefined {
  const script = code + "\n";
  const ast = parse(script) as StmtNS.FileInput;
  const { environments } = analyzeWithEnvironments(ast, script, 4);
  const worklist = new Worklist(ast, environments);
  worklist.drain();

  for (const stmt of ast.statements) {
    if (stmt instanceof StmtNS.FunctionDef && stmt.name.lexeme === fnName) {
      return worklist.tryRead(purityScopeAnalysis, stmt.id);
    }
  }
  throw new Error(`FunctionDef ${fnName} not found`);
}

describe("PurityScopeAnalysis — parity with prior syntactic fold", () => {
  test("pure arithmetic body", () => {
    expect(purityOf("def f(x):\n    return x + 1", "f")).toBe(true);
  });

  test("pure local variable assignment + return", () => {
    expect(purityOf("def f(x):\n    y = x * 2\n    return y", "f")).toBe(true);
  });

  test("pure ternary", () => {
    expect(purityOf("def f(x):\n    return x if x > 0 else -x", "f")).toBe(true);
  });

  test("pure self-recursive call", () => {
    expect(
      purityOf("def f(x):\n    if x <= 0:\n        return 0\n    return f(x - 1)", "f"),
    ).toBe(true);
  });

  test("pure: fibonacci-style double self-recursion stays pure", () => {
    // Regression guard: self-recursion with non-Variable args (here `n-1`,
    // `n-2` — both Binary) must not taint. Args are not bare Variables, so
    // the conservative arg-escape doesn't fire.
    const code = [
      "def fib(n):",
      "    if n < 2:",
      "        return n",
      "    return fib(n - 1) + fib(n - 2)",
    ].join("\n");
    expect(purityOf(code, "fib")).toBe(true);
  });

  test("pure with conditional branches", () => {
    expect(
      purityOf("def f(x):\n    if x > 0:\n        return x\n    else:\n        return -x", "f"),
    ).toBe(true);
  });

  test("pure while loop with local counter", () => {
    expect(
      purityOf(
        "def f(n):\n    i = 0\n    acc = 0\n    while i < n:\n        acc = acc + i\n        i = i + 1\n    return acc",
        "f",
      ),
    ).toBe(true);
  });

  test("impure: user-fn call", () => {
    expect(purityOf("def g(x):\n    return x\ndef f(x):\n    return g(x)", "f")).toBe(false);
  });

  test("impure: print I/O", () => {
    expect(purityOf("def f(x):\n    return print(x)", "f")).toBe(false);
  });

  test("impure: global name read", () => {
    expect(purityOf("g = 1\ndef f(x):\n    return x + g", "f")).toBe(false);
  });

  test("impure: lambda in body", () => {
    expect(purityOf("def f(x):\n    y = lambda z: z\n    return x", "f")).toBe(false);
  });

  test("pure: nested FunctionDef with pure body is defined but not called", () => {
    // Creating a closure is not a side effect. The nested `g` is pure, never
    // called, never returned — `f` just returns its own param.
    expect(purityOf("def f(x):\n    def g(y):\n        return y\n    return x", "f")).toBe(true);
  });

  test("impure: returning a nested FunctionDef that is itself impure", () => {
    // Returning an impure closure escapes it; the caller could invoke it
    // and observe side effects. Tainting propagates to the enclosing fn.
    expect(
      purityOf("def f(x):\n    def g(y):\n        print(y)\n        return y\n    return g", "f"),
    ).toBe(false);
  });

  test("impure: subscript assignment target (parameter aliased)", () => {
    // `xs` is a local slot but aliases a caller-owned list. A subscript-
    // store is a visible mutation; must stay impure.
    expect(purityOf("def f(xs, i):\n    xs[i] = 1\n    return 0", "f")).toBe(false);
  });

  test("impure: global declaration", () => {
    expect(purityOf("def f(x):\n    global g\n    return x", "f")).toBe(false);
  });

  test("pure: bare SimpleExpr of a side-effect-free expression", () => {
    // A bare expression-statement is pure iff the contained expression is.
    // `x + 1;` is arithmetic on a param — no effect, so the function stays pure.
    expect(purityOf("def f(x):\n    x + 1\n    return x", "f")).toBe(true);
  });

  test("impure: bare SimpleExpr of an impure call", () => {
    expect(purityOf("def f(x):\n    print(x)\n    return x", "f")).toBe(false);
  });

  test("impure: assert statement", () => {
    expect(purityOf("def f(x):\n    assert x > 0\n    return x", "f")).toBe(false);
  });
});

describe("PurityScopeAnalysis — CFG-join discriminators", () => {
  test("branchy local write with merging conditional arms is pure", () => {
    // The audit's discriminator: distinct assigns on distinct paths, join
    // at the block after the if. Mod = {y}; y is local → pure.
    const code = [
      "def f(x):",
      "    y = 0",
      "    if x > 0:",
      "        y = 1",
      "    else:",
      "        y = 2",
      "    return y",
    ].join("\n");
    expect(purityOf(code, "f")).toBe(true);
  });

  test("loop-local accumulator is pure", () => {
    // mod = {s, i}; both are local. No impure calls (no `range`/`len` here).
    const code = [
      "def g(n):",
      "    s = 0",
      "    i = 0",
      "    while i < n:",
      "        s = s + i",
      "        i = i + 1",
      "    return s",
    ].join("\n");
    expect(purityOf(code, "g")).toBe(true);
  });
});

describe("PurityScopeAnalysis — capability gains vs. prior rule", () => {
  test("whitelisted builtin `range` in a for-loop iter keeps fn pure", () => {
    // Previously: visitCallExpr marked every Call IMPURE unconditionally
    // → iter impure → whole body impure. Now: `range` is whitelisted.
    const code = [
      "def f(n):",
      "    s = 0",
      "    for i in range(n):",
      "        s = s + i",
      "    return s",
    ].join("\n");
    expect(purityOf(code, "f")).toBe(true);
  });

  test("whitelisted builtin `len` used in a pure body", () => {
    const code = ["def f(xs):", "    n = len(xs)", "    return n + 1"].join("\n");
    // `len(xs)` — xs is a parameter (local slot), `len` is whitelisted
    // → pure. The subscript-read rule wasn't invoked here; we're covering
    // the whitelist by itself.
    expect(purityOf(code, "f")).toBe(true);
  });

  test("subscript read of a parameter is pure", () => {
    // Previously: visitSubscriptExpr unconditional IMPURE → impure fn.
    // Now: subscript-read has no sticky effect; only subscript-STORE does.
    expect(purityOf("def f(xs, i):\n    return xs[i]", "f")).toBe(true);
  });

  test("non-whitelisted builtin stays impure", () => {
    // `print` is not in the whitelist. This is the regression guard for
    // the whitelist change.
    expect(purityOf("def f(x):\n    return print(x)", "f")).toBe(false);
  });
});

describe("PurityScopeAnalysis — freshness / escape tracking", () => {
  test("pure: fresh list allocation, local mutate, element return", () => {
    // xs is Fresh in this frame; the subscript-store targets a locally-
    // owned container. Under the old coarse rule this was impure (any List
    // literal disqualified).
    const code = [
      "def f(n):",
      "    xs = [0, 0]",
      "    xs[0] = n",
      "    return xs[0]",
    ].join("\n");
    expect(purityOf(code, "f")).toBe(true);
  });

  test("impure: subscript-store through a parameter", () => {
    // xs is Param — the store is caller-observable.
    expect(purityOf("def f(xs):\n    xs[0] = 1\n    return 0", "f")).toBe(false);
  });

  test("pure: direct alias of a fresh list", () => {
    // a = xs copies the Fresh abstract value; a[0] = 1 stays pure.
    const code = [
      "def f(n):",
      "    xs = [0]",
      "    a = xs",
      "    a[0] = n",
      "    return a[0]",
    ].join("\n");
    expect(purityOf(code, "f")).toBe(true);
  });

  test("pure: fresh list mutated inside a for-loop body", () => {
    // The loop back-edge joins `xs: Fresh` with itself from the loop body.
    // Same allocation site → stays Fresh across iterations, so `xs[0] = i`
    // remains a store-to-Fresh and the function stays pure.
    const code = [
      "def f(n):",
      "    xs = [0, 0]",
      "    for i in range(n):",
      "        xs[0] = i",
      "    return xs[0]",
    ].join("\n");
    expect(purityOf(code, "f")).toBe(true);
  });

  test("pure: fresh list populated from a param read", () => {
    // `ys` is Fresh; `xs[0]` reads a Param-owned container (pure read).
    // Storing the read result into the Fresh `ys` is pure. This guards the
    // case where a "bare" Fresh mutation is populated from outside data.
    const code = [
      "def f(xs):",
      "    ys = [0]",
      "    ys[0] = xs[0]",
      "    return ys[0]",
    ].join("\n");
    expect(purityOf(code, "f")).toBe(true);
  });

  test("impure: freshness widened to Unknown at a branch merge", () => {
    // If the if-branch binds xs to Fresh and the else-branch binds xs to
    // the Param, the post-merge abstract value is Unknown. A subscript-
    // store on Unknown is conservatively impure.
    const code = [
      "def f(flag, ys):",
      "    if flag:",
      "        xs = [0]",
      "    else:",
      "        xs = ys",
      "    xs[0] = 1",
      "    return 0",
    ].join("\n");
    expect(purityOf(code, "f")).toBe(false);
  });
});

describe("PurityScopeAnalysis — closures (nested FunctionDef)", () => {
  test("pure: nested def called locally", () => {
    const code = [
      "def f(n):",
      "    def double(x):",
      "        return x + x",
      "    return double(n)",
    ].join("\n");
    expect(purityOf(code, "f")).toBe(true);
  });

  test("pure: nested def reading an outer capture", () => {
    // inner reads `n` from the enclosing scope. A capture read is a
    // dependency, not a side effect; inner stays pure and so does outer.
    const code = [
      "def outer(n):",
      "    def inner(x):",
      "        return x + n",
      "    return inner(1)",
    ].join("\n");
    expect(purityOf(code, "outer")).toBe(true);
  });

  test("impure: call through impure nested def", () => {
    // inner is impure (calls print); calling inner in outer makes outer impure.
    const code = [
      "def outer(n):",
      "    def inner(x):",
      "        print(x)",
      "        return x",
      "    return inner(n)",
    ].join("\n");
    expect(purityOf(code, "outer")).toBe(false);
  });
});
