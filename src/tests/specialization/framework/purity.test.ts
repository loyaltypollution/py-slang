/**
 * Tests for the intraprocedural MOD-dataflow purity pass (PurityScopePass).
 *
 * The pass runs a fixpoint CFG walk with a block-level `PurityRecord`
 * (mod-set, call-purity, sticky impure flag) and derives `hint.pure` at
 * the exit block. These tests cover parity with the previous syntactic
 * fold plus the capability gains introduced by:
 *   - a whitelist of memo-safe builtins (`range`, `len`, `abs`, …)
 *   - subscript-read treated as pure (previously IMPURE)
 */

import { StmtNS } from "../../../ast-types";
import { parse } from "../../../parser/parser-adapter";
import { analyzeWithEnvironments } from "../../../resolver";
import { Worklist } from "../../../specialization";
import { purityScopePass } from "../../../specialization/purity-analysis/analysis";

function purityOf(code: string, fnName: string): boolean | undefined {
  const script = code + "\n";
  const ast = parse(script) as StmtNS.FileInput;
  const { environments } = analyzeWithEnvironments(ast, script, 4);
  const worklist = new Worklist(ast, environments);
  worklist.drain();

  for (const stmt of ast.statements) {
    if (stmt instanceof StmtNS.FunctionDef && stmt.name.lexeme === fnName) {
      const p = worklist.factStore.tryRead(purityScopePass, stmt.id);
      return p === "contested" ? undefined : p;
    }
  }
  throw new Error(`FunctionDef ${fnName} not found`);
}

describe("PurityScopePass — parity with prior syntactic fold", () => {
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

  test("impure: nested FunctionDef", () => {
    expect(purityOf("def f(x):\n    def g(y):\n        return y\n    return x", "f")).toBe(false);
  });

  test("impure: subscript assignment target (parameter aliased)", () => {
    // `xs` is a local slot but aliases a caller-owned list. A subscript-
    // store is a visible mutation; must stay impure.
    expect(purityOf("def f(xs, i):\n    xs[i] = 1\n    return 0", "f")).toBe(false);
  });

  test("impure: global declaration", () => {
    expect(purityOf("def f(x):\n    global g\n    return x", "f")).toBe(false);
  });

  test("impure: bare SimpleExpr statement", () => {
    expect(purityOf("def f(x):\n    x + 1\n    return x", "f")).toBe(false);
  });

  test("impure: assert statement", () => {
    expect(purityOf("def f(x):\n    assert x > 0\n    return x", "f")).toBe(false);
  });
});

describe("PurityScopePass — CFG-join discriminators", () => {
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

describe("PurityScopePass — capability gains vs. prior rule", () => {
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
