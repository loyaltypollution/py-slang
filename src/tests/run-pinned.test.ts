/**
 * Regression tests for `runPinned` — the replacement for
 * `SpecializationEngine.run`.
 *
 * The critical invariant: when `fn` throws, the shared pinSet must be
 * cleared (CSE does not pop envs during JS-stack unwind, so stale pins
 * would block the next evaluation's OSR swaps / transform installs).
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
  pinSet: Map<StmtNS.FileInput | StmtNS.FunctionDef, number>;
} {
  const script = code + "\n";
  const ast = parse(script);
  const { environments } = analyzeWithEnvironments(ast, script, 4);
  const pinSet = new Map<StmtNS.FileInput | StmtNS.FunctionDef, number>();
  const worklist = new PersistentWorklist(
    ast,
    environments,
    [new TypeAnalysisModule(), new ConstAnalysisModule()],
    [new DeadBranchEliminationRule(), new ConstantFoldingRule(), new MemoizationTransformRule()],
    pinSet,
  );
  return { worklist, ast, pinSet };
}

describe("runPinned", () => {
  test("fn throws → pinSet.clear() fires", async () => {
    const { worklist, ast, pinSet } = makeWorklist("x = 1");
    worklist.addCallObserver(new CallCountObserver());
    worklist.converge();
    // Seed: simulate a stale pin from a prior interrupted evaluation.
    pinSet.set(ast, 1);
    pinSet.set(ast, 2); // two live ref counts

    const err = new Error("boom");
    await expect(
      runPinned(worklist, null, ast, pinSet, () => {
        throw err;
      }),
    ).rejects.toBe(err);

    expect(pinSet.size).toBe(0);
  });

  test("fn returns normally → pinSet left alone (no leak from runPinned itself)", async () => {
    const { worklist, ast, pinSet } = makeWorklist("x = 1");
    worklist.addCallObserver(new CallCountObserver());
    worklist.converge();

    const result = await runPinned(worklist, null, ast, pinSet, () => 42);

    expect(result).toBe(42);
    // withActiveScope's own pin/unpin cycle should net to zero.
    expect(pinSet.get(ast) ?? 0).toBe(0);
  });

  test("throw propagates through runPinned unchanged", async () => {
    const { worklist, ast, pinSet } = makeWorklist("x = 1");
    worklist.addCallObserver(new CallCountObserver());
    worklist.converge();

    class Custom extends Error {}
    const err = new Custom("specific");

    await expect(
      runPinned(worklist, null, ast, pinSet, () => {
        throw err;
      }),
    ).rejects.toBe(err);
  });
});
