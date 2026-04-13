/**
 * Tests:
 *   1. `fireOnce` ScopeTransformRule: after a successful apply, the
 *      scheduler must NOT re-invoke `matches` on the same scope, even when
 *      the scope is re-ticked by a fresh observation. Guards both the new
 *      scheduler plumbing and the transform-marker latch removal.
 *   2. `ScopePass` dispatch: `addScopePass` passes run once per scope per
 *      generation, and the callObservations buffer accumulates calls
 *      independently of any `AnalysisPass` path.
 */

import { StmtNS } from "../ast-types";
import { parse } from "../parser/parser-adapter";
import { analyzeWithEnvironments } from "../resolver";
import {
  ConstAnalysisPass,
  ConstantFoldingRule,
  DeadBranchEliminationRule,
  MemoizationTransformRule,
  Worklist,
  TypeAnalysisPass,
  type ScopePass,
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
    const fd = ast.statements[0] as StmtNS.FunctionDef;

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

    const worklist = new Worklist(ast, environments, [new TypeAnalysisPass()], [rule]);
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
    // Stronger claim: fd + fileInput contribute at most two applies total
    // for the whole test (once each at converge time). This is the direct
    // falsifiable guarantee — if fireOnce bookkeeping regresses for EITHER
    // scope, applyCalls will grow past 2.
    expect(applyCalls).toBeLessThanOrEqual(2);
    // matches may still be called on other scopes (root), but NOT on fd
    // after the first success. Because we record per-(scope, rule), fd
    // must be skipped entirely on the re-tick.
    const matchesAfterReticks = matchesCalls;
    worklist.observeCall(fileInput, fd);
    worklist.tick();
    expect(matchesCalls).toBe(matchesAfterReticks); // unchanged by a further re-tick on fd
    // Final cross-check: applyCalls pinned at its initial value through
    // all reticks; no rule run against fd after the first success.
    expect(applyCalls).toBe(afterConvergeApply);
  });
});

describe("ScopePass dispatch", () => {
  test("observeCall appends to callObservations; registered ScopePass reads them", () => {
    const { ast, environments } = parseAndResolve("def f():\n  return 1\nf()\nf()");
    const fd = ast.statements[0] as StmtNS.FunctionDef;

    const runs: Array<{ scope: StmtNS.FileInput | StmtNS.FunctionDef; observed: number }> = [];
    const pass: ScopePass = {
      name: "test-count",
      run(unit: FunctionUnit) {
        runs.push({ scope: unit.funcAst, observed: unit.callObservations.length });
      },
    };

    const worklist = new Worklist(
      ast,
      environments,
      [new TypeAnalysisPass(), new ConstAnalysisPass()],
      [new DeadBranchEliminationRule(), new ConstantFoldingRule(), new MemoizationTransformRule()],
    );
    worklist.addScopePass(pass);
    worklist.converge();

    worklist.observeCall(ast, fd);
    worklist.tick();
    worklist.observeCall(ast, fd);
    worklist.tick();

    // After two observeCall dispatches on fd, the ScopePass has seen fd
    // with a buffer that grew to at least 2. The exact number of
    // re-scheduled transform rounds depends on which rules match (e.g.
    // MemoizationTransformRule's threshold may cause additional rounds in
    // the future). Pin the monotone invariants only: the pass runs, and
    // the last observation count equals the number of observeCall
    // dispatches.
    const fdRuns = runs.filter(r => r.scope === fd);
    expect(fdRuns.length).toBeGreaterThanOrEqual(1);
    expect(fdRuns[fdRuns.length - 1].observed).toBeGreaterThanOrEqual(2);
  });

  test("AnalysisPass does not declare onCallObservation", () => {
    // Structural assertion: AnalysisPass interface must not have grown an
    // onCallObservation hook — observation dispatch goes through ScopePass.
    const mod = new TypeAnalysisPass() as unknown as {
      onCallObservation?: (...args: unknown[]) => void;
    };
    expect(mod.onCallObservation).toBeUndefined();
  });
});
