/**
 * Convergence benchmark suite for PersistentWorklist.
 *
 * Measures convergence cost (items processed, transform rounds, wall-clock time)
 * across programs of increasing complexity. Results are printed as a table
 * during test output for manual inspection.
 */

import { parse } from "../parser/parser-adapter";
import { analyzeWithEnvironments } from "../resolver";
import { createReactiveOptimization } from "../specialization";
import type { WorklistStats } from "../specialization";

// ── Test setup ─────────────────────────────────────────────────────────────

function parseAndResolve(code: string) {
  const script = code + "\n";
  const ast = parse(script);
  const { environments } = analyzeWithEnvironments(ast, script, 4);
  return { ast, environments };
}

function benchmarkProgram(code: string): WorklistStats & { scopes: number } {
  const { ast, environments } = parseAndResolve(code);
  const reactive = createReactiveOptimization(ast, environments);
  reactive.resetStats();
  reactive.converge();
  return { ...reactive.stats, scopes: reactive.units.size };
}

// ── Benchmark programs ─────────────────────────────────────────────────────

const benchmarks = [
  { name: "trivial assignment", code: "x = 1" },
  { name: "dead branch (True)", code: "if True:\n  x = 1\nelse:\n  x = 2" },
  { name: "constant folding", code: "x = 1 + 2 * 3" },
  { name: "compound optimization", code: "if True:\n  x = 1 + 2\nelse:\n  x = 99" },
  {
    name: "nested control flow",
    code: "if True:\n  if False:\n    x = 1\n  else:\n    x = 2\nelse:\n  x = 3",
  },
  { name: "while loop", code: "x = 0\nwhile x < 10:\n  x = x + 1" },
  {
    name: "multiple functions",
    code: "def f(a):\n  return a + 1\ndef g(b):\n  return b * 2\nx = f(3) + g(4)",
  },
  {
    name: "nested functions",
    code: "def outer(x):\n  def inner(y):\n    return y + 1\n  return inner(x)\nresult = outer(5)",
  },
  { name: "chained operations", code: "a = 1\nb = a + 2\nc = b + 3\nd = c + 4\ne = d + 5" },
  {
    name: "mixed control + functions",
    code: "def f(x):\n  if x > 0:\n    return x\n  else:\n    return 0\ny = f(5) + f(-1)",
  },
];

// ── Individual benchmark tests ─────────────────────────────────────────────

describe("Convergence benchmarks", () => {
  test.each(benchmarks)("$name: converges with measurable work", ({ code }) => {
    const result = benchmarkProgram(code);

    // Every program should process at least some items
    expect(result.itemsProcessed).toBeGreaterThan(0);
    expect(result.drainCalls).toBeGreaterThan(0);
    expect(result.analysisItemsProcessed).toBeGreaterThan(0);
    expect(result.transformRounds).toBeGreaterThanOrEqual(0);
    expect(result.wallClockMs).toBeGreaterThanOrEqual(0);

    // Analysis items + transform items = total items
    expect(result.analysisItemsProcessed + result.transformItemsProcessed).toBe(
      result.itemsProcessed,
    );
  });

  test("programs with transforms have transformRounds > 0", () => {
    // Dead branch elimination and constant folding should fire
    const deadBranch = benchmarkProgram("if True:\n  x = 1\nelse:\n  x = 2");
    expect(deadBranch.transformRounds).toBeGreaterThan(0);

    const constFold = benchmarkProgram("x = 1 + 2 * 3");
    expect(constFold.transformRounds).toBeGreaterThan(0);
  });

  test("trivial program has fewer items than complex program", () => {
    const trivial = benchmarkProgram("x = 1");
    const complex = benchmarkProgram(
      "def f(x):\n  if x > 0:\n    return x\n  else:\n    return 0\ny = f(5) + f(-1)",
    );
    expect(complex.itemsProcessed).toBeGreaterThan(trivial.itemsProcessed);
  });

  // ── Summary table ──────────────────────────────────────────────────────

  test("summary: print comparison table", () => {
    const rows = benchmarks.map(({ name, code }) => {
      const s = benchmarkProgram(code);
      return {
        program: name,
        scopes: s.scopes,
        items: s.itemsProcessed,
        analysis: s.analysisItemsProcessed,
        transforms: s.transformItemsProcessed,
        rounds: s.transformRounds,
        drains: s.drainCalls,
        "ms": Number(s.wallClockMs.toFixed(3)),
      };
    });

    // eslint-disable-next-line no-console
    console.table(rows);

    // Sanity: table was built without error
    expect(rows.length).toBe(benchmarks.length);
  });
});
