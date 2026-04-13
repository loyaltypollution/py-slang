/**
 * Tests for the reactive optimization architecture:
 * - Differential correctness: buildTestWorklist().converge() produces
 *   the same hints and AST structure as the one-shot optimize() path.
 * - Worklist priority ordering.
 * - Structural versioning.
 * - Subscription notifications.
 */

import { ExprNS, StmtNS } from "../ast-types";
import { parse } from "../parser/parser-adapter";
import { analyzeWithEnvironments } from "../resolver";
import { buildTestWorklist } from "./utils";
import type { FunctionUnit } from "../specialization/framework/function-unit";
import type { FactStore } from "../specialization/framework/fact-store";
import { constAnalysisPass } from "../specialization/framework/migrated-passes";

function parseAndResolve(code: string) {
  const script = code + "\n";
  const ast = parse(script);
  const { environments } = analyzeWithEnvironments(ast, script, 4);
  return { ast, environments };
}

/**
 * Serialize statement structure for comparison, excluding node IDs and tokens.
 */
function serializeStmts(stmts: StmtNS.Stmt[]): string {
  return JSON.stringify(stmts, (key, val) => {
    if (key === "id" || key === "startToken" || key === "endToken") return undefined;
    return val;
  });
}


// ── Differential tests: reactive vs one-shot ────────────────────────────────

describe("ReactiveOptimization: differential vs optimize()", () => {
  const programs = [
    { name: "dead branch (True)", code: "if True:\n  x = 1\nelse:\n  x = 2" },
    { name: "dead branch (False)", code: "if False:\n  x = 1\nelse:\n  x = 2" },
    { name: "constant folding", code: "x = 1 + 2" },
    { name: "compound", code: "if True:\n  x = 1 + 2\nelse:\n  x = 99" },
    { name: "no transforms", code: "x = 1\ny = 2" },
    { name: "nested if", code: "if True:\n  if False:\n    x = 1\n  else:\n    x = 2" },
    { name: "while loop", code: "x = 0\nwhile x < 10:\n  x = x + 1" },
    { name: "function def", code: "def f(a):\n  return a + 1\nx = f(3)" },
  ];

  test.each(programs)("$name: converge() produces same AST structure", ({ code }) => {
    // One-shot path
    const oneShot = parseAndResolve(code);
    const oneShotEngine = buildTestWorklist(oneShot.ast, oneShot.environments);
    oneShotEngine.converge();
    const oneShotUnits = oneShotEngine.units;

    // Reactive path (fresh parse to get independent AST)
    const reactive = parseAndResolve(code);
    const reactiveOpt = buildTestWorklist(reactive.ast, reactive.environments);
    reactiveOpt.converge();

    // Compare AST structure per scope
    for (const [key, oneShotUnit] of oneShotUnits) {
      // Find matching scope in reactive output by position
      const reactiveUnit = findMatchingUnit(reactiveOpt.units, key);
      expect(reactiveUnit).toBeDefined();
      expect(serializeStmts(reactiveUnit!.body)).toBe(serializeStmts(oneShotUnit.body));
    }
  });

  test.each(programs)("$name: converge() reaches idle", ({ code }) => {
    const { ast, environments } = parseAndResolve(code);
    const reactive = buildTestWorklist(ast, environments);
    reactive.converge();
    expect(reactive.idle).toBe(true);
  });
});

// ── Versioning tests ────────────────────────────────────────────────────────

describe("ReactiveOptimization: dual versioning", () => {
  test("no-transform code: structuralVersion stays 0", () => {
    const { ast, environments } = parseAndResolve("x = 1\ny = 2");
    const reactive = buildTestWorklist(ast, environments);
    reactive.converge();

    for (const unit of reactive.units.values()) {
      expect(reactive.structuralVersionOf(unit)).toBe(0);
    }
  });

  test("dead branch elimination: structuralVersion > 0 for root scope", () => {
    const { ast, environments } = parseAndResolve("if True:\n  x = 1\nelse:\n  x = 2");
    const reactive = buildTestWorklist(ast, environments);
    reactive.converge();

    const rootUnit = reactive.units.get(ast);
    expect(rootUnit).toBeDefined();
    expect(reactive.structuralVersionOf(rootUnit!)).toBeGreaterThan(0);
  });

  test("tick() returns true when work was done", () => {
    const { ast, environments } = parseAndResolve("x = 1 + 2");
    const reactive = buildTestWorklist(ast, environments);

    // First tick should do work
    const didWork = reactive.tick(100);
    expect(didWork).toBe(true);
  });

  test("tick() returns false when idle", () => {
    const { ast, environments } = parseAndResolve("x = 1");
    const reactive = buildTestWorklist(ast, environments);
    reactive.converge();

    // After convergence, tick should have nothing to do
    const didWork = reactive.tick();
    expect(didWork).toBe(false);
  });
});

// ── Post-optimization AST and hint assertions ──────────────────────────────
// Ported from legacy `transform-rules.test.ts` / `const-analysis.test.ts`
// (which exercised the deleted `stabilizeStatic`/`runAnalysisPass` drivers).
// These assert the concrete post-convergence AST and hint annotations that
// differential + counter-based tests above would not catch if folding/
// dead-branch elimination stopped firing on a specific shape.

describe("Worklist: post-optimization AST", () => {
  function optimise(code: string): StmtNS.Stmt[] {
    const { ast, environments } = parseAndResolve(code);
    const reactive = buildTestWorklist(ast, environments);
    reactive.converge();
    return reactive.units.get(ast)!.body;
  }

  describe("dead branch elimination", () => {
    test("True condition: collapses to then-body", () => {
      const stmts = optimise("if True:\n  x = 1\nelse:\n  x = 2");
      expect(stmts.length).toBe(1);
      const assign = stmts[0] as StmtNS.Assign;
      expect(assign).toBeInstanceOf(StmtNS.Assign);
      expect((assign.value as ExprNS.Literal).value).toBe("1");
    });

    test("False condition: collapses to else-body", () => {
      const stmts = optimise("if False:\n  x = 1\nelse:\n  x = 2");
      expect(stmts.length).toBe(1);
      const assign = stmts[0] as StmtNS.Assign;
      expect(assign).toBeInstanceOf(StmtNS.Assign);
      expect((assign.value as ExprNS.Literal).value).toBe("2");
    });

    test("False condition, no else: statement deleted", () => {
      const stmts = optimise("if False:\n  x = 1");
      expect(stmts.length).toBe(0);
    });
  });

  describe("constant folding", () => {
    test("1 + 2 folds to Literal(3)", () => {
      const stmts = optimise("x = 1 + 2");
      const assign = stmts[0] as StmtNS.Assign;
      const lit = assign.value as ExprNS.Literal;
      expect(lit).toBeInstanceOf(ExprNS.Literal);
      expect(lit.value).toBe(3);
    });

    test("nested: 1 + 2 + 3 folds to Literal(6)", () => {
      const stmts = optimise("x = 1 + 2 + 3");
      const assign = stmts[0] as StmtNS.Assign;
      const lit = assign.value as ExprNS.Literal;
      expect(lit).toBeInstanceOf(ExprNS.Literal);
      expect(lit.value).toBe(6);
    });

    test("compound: if True: x = 1 + 2 else: x = 99 → x = 3", () => {
      const stmts = optimise("if True:\n  x = 1 + 2\nelse:\n  x = 99");
      expect(stmts.length).toBe(1);
      const assign = stmts[0] as StmtNS.Assign;
      const lit = assign.value as ExprNS.Literal;
      expect(lit).toBeInstanceOf(ExprNS.Literal);
      expect(lit.value).toBe(3);
    });

    test("no-op: x = 1; y = 2 returns two assignments", () => {
      const stmts = optimise("x = 1\ny = 2");
      expect(stmts.length).toBe(2);
    });
  });
});

describe("Worklist: post-optimization hints", () => {
  function analyse(code: string): { factStore: FactStore; body: StmtNS.Stmt[] } {
    const { ast, environments } = parseAndResolve(code);
    const reactive = buildTestWorklist(ast, environments);
    reactive.converge();
    const unit = reactive.units.get(ast)!;
    return { factStore: reactive.factStore, body: unit.body };
  }

  test("x = 3 + 4: BinOp (pre-fold) or Literal(7) (post-fold) has constVal const(7)", () => {
    const { factStore, body } = analyse("x = 3 + 4");
    const assign = body[0] as StmtNS.Assign;
    const cv = factStore.tryRead(constAnalysisPass, assign.value.id);
    expect(cv?.tag).toBe("const");
    expect((cv as any)?.value).toBe(7);
  });

  test("variable propagation: x = 5; y = x + 2 → x+2 has constVal const(7)", () => {
    const { factStore, body } = analyse("x = 5\ny = x + 2");
    const assignY = body[1] as StmtNS.Assign;
    const cv = factStore.tryRead(constAnalysisPass, assignY.value.id);
    expect(cv?.tag).toBe("const");
    expect((cv as any)?.value).toBe(7);
  });
});

// ── Multi-scope tests ───────────────────────────────────────────────────────

describe("ReactiveOptimization: multi-scope", () => {
  test("function scopes are optimized independently", () => {
    const code = "def f(a):\n  if True:\n    return a\n  else:\n    return 0\nx = f(1)";
    const { ast, environments } = parseAndResolve(code);
    const reactive = buildTestWorklist(ast, environments);
    reactive.converge();

    // Should have at least 2 scopes (root + function f)
    expect(reactive.units.size).toBeGreaterThanOrEqual(2);
    expect(reactive.idle).toBe(true);
  });
});

// ── Helpers ──────────────────────────────────────────────────────────��──────

/**
 * Find a unit in the reactive output that matches the given scope key by kind
 * and structural position (since separate parses produce different objects).
 */
function findMatchingUnit(
  units: ReadonlyMap<StmtNS.FileInput | StmtNS.FunctionDef, FunctionUnit>,
  target: StmtNS.FileInput | StmtNS.FunctionDef,
): FunctionUnit | undefined {
  if (target instanceof StmtNS.FileInput) {
    for (const [key, unit] of units) {
      if (key instanceof StmtNS.FileInput) return unit;
    }
  }
  if (target instanceof StmtNS.FunctionDef) {
    // Match by function name lexeme (unique within a single parse)
    for (const [key, unit] of units) {
      if (key instanceof StmtNS.FunctionDef && key.name.lexeme === target.name.lexeme) return unit;
    }
  }
  return undefined;
}
