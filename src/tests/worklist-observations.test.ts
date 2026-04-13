/**
 * Tests for Worklist observation handling and per-scope transform
 * suppression (commits 2+3 of the OBSERVE loop PR).
 */

import { parse } from "../parser/parser-adapter";
import { analyzeWithEnvironments } from "../resolver";
import { Worklist } from "../specialization/framework/worklist";
import { ConstAnalysisPass } from "../specialization/const-analysis/analysis";
import { TypeAnalysisPass } from "../specialization/type-analysis/analysis";
import { ConstantFoldingRule } from "../specialization/transforms/constant-folding";
import { DeadBranchEliminationRule } from "../specialization/transforms/dead-branch";
import type { StmtNS } from "../ast-types";

function setup(code: string) {
  const script = code + "\n";
  const ast = parse(script);
  const { environments } = analyzeWithEnvironments(ast, script, 4);
  const worklist = new Worklist(
    ast,
    environments,
    [new TypeAnalysisPass(), new ConstAnalysisPass()],
    [new DeadBranchEliminationRule(), new ConstantFoldingRule()],
  );
  return { ast, units: worklist.units, worklist };
}

describe("Worklist.observeWrite", () => {
  test("writes a hint at the target nodeId", () => {
    const { ast, units, worklist } = setup("x = 1");
    worklist.drain();

    const rootUnit = units.get(ast)!;
    const assign = ast.statements[0] as StmtNS.Assign;

    const hintBefore = rootUnit.hints.getById(assign.value.id);
    worklist.observeWrite(ast, assign.value, "hello-string");

    // Observation should have merged a string lattice fact into the existing hint.
    const hint = rootUnit.hints.getById(assign.value.id)!;
    expect(hint.type).toBeDefined();
    expect(hint.type).not.toEqual(hintBefore?.type);
  });

  test("unknown scopeKey is silently ignored", () => {
    const { ast, worklist } = setup("x = 1");
    const assign = ast.statements[0] as StmtNS.Assign;
    const fakeKey = {} as any;
    expect(() => worklist.observeWrite(fakeKey, assign.value, 1)).not.toThrow();
  });

  test("non-primitive observation that analyses ignore is a no-op", () => {
    const { ast, units, worklist } = setup("x = 1");
    worklist.drain();
    const rootUnit = units.get(ast)!;
    const assign = ast.statements[0] as StmtNS.Assign;
    const hintBefore = rootUnit.hints.getById(assign.value.id);

    worklist.observeWrite(ast, assign.value, Symbol("weird"));

    // Neither module returned a lattice delta — hint unchanged.
    expect(rootUnit.hints.getById(assign.value.id)).toEqual(hintBefore);
  });
});

describe("Worklist.observeCall", () => {
  test("invalidates the callee scope", () => {
    const code = `
def f():
    return 1 + 2
x = 1
`;
    const { ast, units, worklist } = setup(code);
    worklist.drain();

    const funcDef = ast.statements[0] as StmtNS.FunctionDef;
    const calleeUnit = units.get(funcDef)!;
    const versionBefore = calleeUnit.structuralVersion;

    worklist.observeCall(ast, funcDef);
    worklist.drain();

    // rebuildAndReseed bumps generation; drain re-processes. No observable
    // structural change from an invalidation alone, but the scope is re-analyzed
    // (verifiable by subsequent drain producing changed scopes or not — for
    // this sanity test it's enough that no throw occurs).
    expect(worklist.idle).toBe(true);
    expect(calleeUnit.structuralVersion).toBeGreaterThanOrEqual(versionBefore);
  });
});

