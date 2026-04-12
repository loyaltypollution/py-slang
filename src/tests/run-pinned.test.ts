/**
 * Regression tests for `runPinned` — the replacement for
 * `SpecializationEngine.run`.
 *
 * Post-C8 collapse: there is no external `pinSet` Map. The pin count lives
 * on `FunctionUnit.pinCount` directly. On throw, `runPinned` zeroes every
 * unit's pinCount — stale pins would otherwise block the next evaluation's
 * OSR swaps / transform installs (CSE does not pop envs during JS-stack
 * unwind).
 */

import { StmtNS } from "../ast-types";
import { parse } from "../parser/parser-adapter";
import { analyzeWithEnvironments } from "../resolver";
import {
  ConstAnalysisModule,
  ConstantFoldingRule,
  DeadBranchEliminationRule,
  CallCountObserver,
  MemoizationTransformRule,
  PersistentWorklist,
  TypeAnalysisModule,
} from "../specialization";
import { runPinned } from "../specialization/run-pinned";

function makeWorklist(code: string): {
  worklist: PersistentWorklist;
  ast: StmtNS.FileInput;
} {
  const script = code + "\n";
  const ast = parse(script);
  const { environments } = analyzeWithEnvironments(ast, script, 4);
  const worklist = new PersistentWorklist(
    ast,
    environments,
    [new TypeAnalysisModule(), new ConstAnalysisModule()],
    [new DeadBranchEliminationRule(), new ConstantFoldingRule(), new MemoizationTransformRule()],
  );
  worklist.addCallObserver(new CallCountObserver());
  return { worklist, ast };
}

describe("runPinned", () => {
  test("fn throws → all FunctionUnit.pinCount reset to 0", async () => {
    const { worklist, ast } = makeWorklist("def f():\n  return 1\n");
    worklist.converge();
    // Seed: simulate stale pins from a prior interrupted evaluation.
    worklist.activateScope(ast);
    worklist.activateScope(ast);
    expect(worklist.units.get(ast)!.pinCount).toBeGreaterThan(0);

    const err = new Error("boom");
    await expect(
      runPinned(worklist, null, ast, () => {
        throw err;
      }),
    ).rejects.toBe(err);

    for (const [, unit] of worklist.units) {
      expect(unit.pinCount).toBe(0);
    }
  });

  test("fn returns normally → root scope pinCount nets to 0", async () => {
    const { worklist, ast } = makeWorklist("x = 1");
    worklist.converge();

    const result = await runPinned(worklist, null, ast, () => 42);

    expect(result).toBe(42);
    expect(worklist.units.get(ast)!.pinCount).toBe(0);
  });

  test("throw propagates through runPinned unchanged", async () => {
    const { worklist, ast } = makeWorklist("x = 1");
    worklist.converge();

    class Custom extends Error {}
    const err = new Custom("specific");

    await expect(
      runPinned(worklist, null, ast, () => {
        throw err;
      }),
    ).rejects.toBe(err);
  });
});
