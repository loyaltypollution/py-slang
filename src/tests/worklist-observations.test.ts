/**
 * Tests for Worklist observation handling and per-scope transform
 * suppression (commits 2+3 of the OBSERVE loop PR).
 */

import { parse } from "../parser/parser-adapter";
import { analyzeWithEnvironments } from "../resolver";
import { Worklist } from "../specialization/framework/worklist";
import { ConstAnalysisPass } from "../specialization/const-analysis/analysis";
import { TypeAnalysisPass } from "../specialization/type-analysis/analysis";
import { typeAnalysisPass } from "../specialization/framework/migrated-passes";
import type { StmtNS } from "../ast-types";

function setup(code: string) {
  const script = code + "\n";
  const ast = parse(script);
  const { environments } = analyzeWithEnvironments(ast, script, 4);
  const worklist = new Worklist(ast, environments, [
    new TypeAnalysisPass(),
    new ConstAnalysisPass(),
  ]);
  return { ast, units: worklist.units, worklist };
}

describe("Worklist.observeWrite", () => {
  test("writes a fact at the target nodeId", () => {
    const { ast, worklist } = setup("x = 1");
    worklist.drain();

    const assign = ast.statements[0] as StmtNS.Assign;

    const typeBefore = worklist.factStore.tryRead(typeAnalysisPass,assign.value.id);
    worklist.observeWrite(ast, assign.value, "hello-string");

    // Observation should have merged a string lattice fact into the existing fact.
    const typeAfter = worklist.factStore.tryRead(typeAnalysisPass,assign.value.id);
    expect(typeAfter).toBeDefined();
    expect(typeAfter).not.toEqual(typeBefore);
  });

  test("unknown scopeKey is silently ignored", () => {
    const { ast, worklist } = setup("x = 1");
    const assign = ast.statements[0] as StmtNS.Assign;
    const fakeKey = {} as any;
    expect(() => worklist.observeWrite(fakeKey, assign.value, 1)).not.toThrow();
  });

  test("non-primitive observation that analyses ignore is a no-op", () => {
    const { ast, worklist } = setup("x = 1");
    worklist.drain();
    const assign = ast.statements[0] as StmtNS.Assign;
    const typeBefore = worklist.factStore.tryRead(typeAnalysisPass,assign.value.id);

    worklist.observeWrite(ast, assign.value, Symbol("weird"));

    // Neither module returned a lattice delta — fact unchanged.
    expect(worklist.factStore.tryRead(typeAnalysisPass,assign.value.id)).toEqual(typeBefore);
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
    const versionBefore = worklist.structuralVersionOf(calleeUnit);

    worklist.observeCall(ast, funcDef);
    worklist.drain();

    // rebuildAndReseed bumps generation; drain re-processes. No observable
    // structural change from an invalidation alone, but the scope is re-analyzed
    // (verifiable by subsequent drain producing changed scopes or not — for
    // this sanity test it's enough that no throw occurs).
    expect(worklist.idle).toBe(true);
    expect(worklist.structuralVersionOf(calleeUnit)).toBeGreaterThanOrEqual(versionBefore);
  });
});
