/**
 * ε1 red tests:
 *   1. `fireOnce` ScopeTransformRule: after a successful apply, the
 *      scheduler must NOT re-invoke `matches` on the same scope, even when
 *      the scope is re-ticked by a fresh observation. Guards both the new
 *      scheduler plumbing and the `MEMOIZED_FIELD` latch removal.
 *   2. `CallObserver` dispatch: `addCallObserver` observers fire on
 *      `observeCall`, independently of any `AnalysisModule` path.
 */

import { StmtNS } from "../ast-types";
import { parse } from "../parser/parser-adapter";
import { analyzeWithEnvironments } from "../resolver";
import {
  ConstAnalysisModule,
  ConstantFoldingRule,
  DeadBranchEliminationRule,
  MemoizationTransformRule,
  PersistentWorklist,
  TypeAnalysisModule,
  type CallObserver,
  type FunctionUnit,
} from "../specialization";
import type { ScopeTransformRule } from "../specialization/framework/interfaces";

function parseAndResolve(code: string) {
  const script = code + "\n";
  const ast = parse(script) as StmtNS.FileInput;
  const { environments } = analyzeWithEnvironments(ast, script, 4);
  return { ast, environments };
}

describe("ScopeTransformRule fireOnce scheduling", () => {
  test("after successful apply, scheduler does not re-invoke matches on same scope", () => {
    // Program with a callable function so we can force re-ticks via multiple
    // observeCall dispatches on the same FunctionDef.
    const { ast, environments } = parseAndResolve("def f():\n  return 1\nf()\nf()");
    const fd = (ast.statements[0] as StmtNS.FunctionDef);

    // A one-shot rule that always matches and always applies. Instrumented
    // with a call-count on both matches and apply.
    let matchesCalls = 0;
    let applyCalls = 0;
    const rule: ScopeTransformRule = {
      name: "test-one-shot",
      level: "scope",
      fireOnce: true,
      matches(_unit: FunctionUnit): boolean {
        matchesCalls++;
        return true;
      },
      apply(unit: FunctionUnit): boolean {
        applyCalls++;
        unit.structuralVersion++;
        return true;
      },
    };

    const worklist = new PersistentWorklist(
      ast,
      environments,
      [new TypeAnalysisModule()],
      [rule],
    );
    worklist.converge();
    const afterConvergeApply = applyCalls;

    // Force a fresh transform enqueue on the function scope by calling
    // observeCall, which rebuilds + reseeds the callee. Without fireOnce,
    // the rule would re-match on this second pass.
    const fileInput = ast;
    worklist.observeCall(fileInput, fd);
    worklist.tick();
    worklist.observeCall(fileInput, fd);
    worklist.tick();

    // apply should have fired at most once per scope on the first round.
    // The second/third re-enqueue must not cause additional apply calls.
    expect(applyCalls).toBe(afterConvergeApply);
    // matches may still be called on other scopes (root), but NOT on fd
    // after the first success. Because we record per-(scope, rule), fd
    // must be skipped entirely on the re-tick.
    // Capture the matches count after all re-ticks — if fireOnce works,
    // matches count did not keep growing unboundedly with each re-tick.
    const matchesAfterReticks = matchesCalls;
    worklist.observeCall(fileInput, fd);
    worklist.tick();
    expect(matchesCalls).toBe(matchesAfterReticks); // unchanged by a further re-tick on fd
  });
});

describe("CallObserver dispatch", () => {
  test("addCallObserver receives onCallObservation for every observeCall", () => {
    const { ast, environments } = parseAndResolve("def f():\n  return 1\nf()\nf()");
    const fd = ast.statements[0] as StmtNS.FunctionDef;

    const calls: Array<{
      caller: StmtNS.FileInput | StmtNS.FunctionDef;
      callee: StmtNS.FileInput | StmtNS.FunctionDef;
    }> = [];
    const observer: CallObserver = {
      onCallObservation(caller, callee) {
        calls.push({ caller, callee });
      },
    };

    const worklist = new PersistentWorklist(
      ast,
      environments,
      [new TypeAnalysisModule(), new ConstAnalysisModule()],
      [new DeadBranchEliminationRule(), new ConstantFoldingRule(), new MemoizationTransformRule()],
    );
    worklist.addCallObserver(observer);
    worklist.converge();

    worklist.observeCall(ast, fd);
    worklist.tick();
    worklist.observeCall(ast, fd);
    worklist.tick();

    expect(calls.length).toBe(2);
    expect(calls[0].caller).toBe(ast);
    expect(calls[0].callee).toBe(fd);
    expect(calls[1].callee).toBe(fd);
  });

  test("AnalysisModule no longer receives onCallObservation path", () => {
    // Structural assertion: AnalysisModule interface must not declare
    // onCallObservation. If this assertion flips, the ε1 split has leaked.
    const mod = new TypeAnalysisModule() as unknown as {
      onCallObservation?: (...args: unknown[]) => void;
    };
    expect(mod.onCallObservation).toBeUndefined();
  });
});
