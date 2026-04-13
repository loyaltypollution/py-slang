/**
 * Parity tests for the PurityEffectAnalysis + PurityScopePass split.
 *
 * The old implementation was a single syntactic check `isPureFunctionDef`.
 * The new split (expression-level lattice pass + scope-level summary fold)
 * must classify the same function bodies as pure/impure. Each test feeds
 * a FunctionDef through a Worklist wired with both passes and asserts the
 * `pure` hint on its FunctionDef matches the expected verdict.
 */

import { StmtNS } from "../ast-types";
import { parse } from "../parser/parser-adapter";
import { analyzeWithEnvironments } from "../resolver";
import {
  ConstAnalysisPass,
  PurityEffectAnalysis,
  PurityScopePass,
  TypeAnalysisPass,
  Worklist,
  PURE_FIELD,
} from "../specialization";

function purityOf(code: string, fnName: string): boolean | undefined {
  const script = code + "\n";
  const ast = parse(script) as StmtNS.FileInput;
  const { environments } = analyzeWithEnvironments(ast, script, 4);
  const worklist = new Worklist(
    ast,
    environments,
    [new TypeAnalysisPass(), new ConstAnalysisPass(), new PurityEffectAnalysis()],
    [],
  );
  worklist.addScopePass(new PurityScopePass());
  worklist.converge();

  for (const stmt of ast.statements) {
    if (stmt instanceof StmtNS.FunctionDef && stmt.name.lexeme === fnName) {
      return worklist.units.get(stmt)?.hints.get(stmt)?.[PURE_FIELD] as boolean | undefined;
    }
  }
  throw new Error(`FunctionDef ${fnName} not found`);
}

describe("PurityEffectAnalysis + PurityScopePass parity", () => {
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
    expect(purityOf("def f(x):\n    if x <= 0:\n        return 0\n    return f(x - 1)", "f")).toBe(
      true,
    );
  });

  test("impure: subscript read", () => {
    expect(purityOf("def f(xs):\n    return xs[0]", "f")).toBe(false);
  });

  test("impure: external call", () => {
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

  test("impure: subscript assignment target", () => {
    expect(purityOf("def f(xs, i):\n    xs[i] = 1\n    return 0", "f")).toBe(false);
  });

  test("pure with conditional branches", () => {
    expect(
      purityOf(
        "def f(x):\n    if x > 0:\n        return x\n    else:\n        return -x",
        "f",
      ),
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
});
