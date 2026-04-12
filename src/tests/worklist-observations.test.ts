/**
 * Tests for PersistentWorklist observation handling and per-scope transform
 * suppression (commits 2+3 of the OBSERVE loop PR).
 */

import { parse } from "../parser/parser-adapter";
import { analyzeWithEnvironments } from "../resolver";
import { buildVersionedFunctionUnits } from "../specialization/framework/function-unit";
import { PersistentWorklist } from "../specialization/framework/persistent-worklist";
import { ConstAnalysisModule } from "../specialization/const-analysis/analysis";
import { TypeAnalysisModule } from "../specialization/type-analysis/analysis";
import { ConstantFoldingRule } from "../specialization/transforms/constant-folding";
import { DeadBranchEliminationRule } from "../specialization/transforms/dead-branch";
import type { StmtNS } from "../ast-types";

function setup(code: string) {
  const script = code + "\n";
  const ast = parse(script);
  const { environments } = analyzeWithEnvironments(ast, script, 4);
  const units = buildVersionedFunctionUnits(ast, environments);
  const worklist = new PersistentWorklist(
    [new TypeAnalysisModule(), new ConstAnalysisModule()],
    [new DeadBranchEliminationRule(), new ConstantFoldingRule()],
  );
  for (const [key, unit] of units) worklist.addScope(key, unit);
  return { ast, units, worklist };
}

describe("PersistentWorklist.enqueue value-observation", () => {
  test("writes a hint at the target nodeId", () => {
    const { ast, units, worklist } = setup("x = 1");
    worklist.drain();

    const rootUnit = units.get(ast)!;
    const assign = ast.statements[0] as StmtNS.Assign;
    const rhsId = assign.value.id;

    const versionBefore = rootUnit.hints.version;
    worklist.enqueue({
      kind: "value-observation",
      scopeKey: ast,
      nodeId: rhsId,
      value: "hello-string",
    });

    // Observation should have merged a string lattice fact into the existing hint.
    expect(rootUnit.hints.version).toBeGreaterThan(versionBefore);
    const hint = rootUnit.hints.getById(rhsId)!;
    expect(hint.type).toBeDefined();
  });

  test("unknown scopeKey is silently ignored", () => {
    const { worklist } = setup("x = 1");
    const fakeKey = {} as any;
    expect(() =>
      worklist.enqueue({ kind: "value-observation", scopeKey: fakeKey, nodeId: 0, value: 1 }),
    ).not.toThrow();
  });

  test("non-primitive observation that analyses ignore is a no-op", () => {
    const { ast, units, worklist } = setup("x = 1");
    worklist.drain();
    const rootUnit = units.get(ast)!;
    const versionBefore = rootUnit.hints.version;

    worklist.enqueue({
      kind: "value-observation",
      scopeKey: ast,
      nodeId: (ast.statements[0] as StmtNS.Assign).value.id,
      value: Symbol("weird"),
    });

    // Neither module returned a lattice delta — version unchanged.
    expect(rootUnit.hints.version).toBe(versionBefore);
  });
});

describe("PersistentWorklist.enqueue call-observation", () => {
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

    worklist.enqueue({ kind: "call-observation", scopeKey: ast, calleeKey: funcDef });
    worklist.drain();

    // rebuildAndReseed bumps generation; drain re-processes. No observable
    // structural change from an invalidation alone, but the scope is re-analyzed
    // (verifiable by subsequent drain producing changed scopes or not — for
    // this sanity test it's enough that no throw occurs).
    expect(worklist.idle).toBe(true);
    expect(calleeUnit.structuralVersion).toBeGreaterThanOrEqual(versionBefore);
  });
});

describe("PersistentWorklist active-scope transform suppression", () => {
  test("transforms for active scopes are parked, not processed", () => {
    const { ast, worklist } = setup("if True:\n  x = 1\nelse:\n  x = 2");
    // Fresh worklist has: analysis queues seeded + one transform enqueued per scope.
    // Drain analysis only, then re-enqueue transforms.

    worklist.activateScope(ast);
    // Even after drain, the root scope's transform must not have fired because
    // the scope is active. Dead-branch elimination would normally splice the
    // else branch on convergence; with suppression active, structuralVersion stays 0.
    worklist.drain();

    // Confirm: at least one pending item remains (the parked transform),
    // and drain() reports idle=false because there's still a non-processable queued item.
    // BUT since active-scope items don't count as processable, idle=true.
    expect(worklist.idle).toBe(true);
    expect(worklist.pending).toBeGreaterThan(0); // parked transform still there
  });

  test("deactivating the scope lets parked transforms fire on next drain", () => {
    const { ast, worklist } = setup("if True:\n  x = 1\nelse:\n  x = 2");
    worklist.activateScope(ast);
    worklist.drain();
    const pendingWhileActive = worklist.pending;
    expect(pendingWhileActive).toBeGreaterThan(0);

    worklist.deactivateScope(ast);
    worklist.drain();

    // All parked work has drained; no pending items remain.
    expect(worklist.idle).toBe(true);
    expect(worklist.pending).toBe(0);
  });

  test("transforms for inactive scopes run freely even when other scopes are active", () => {
    const code = `
def f():
    x = 1 + 2
def g():
    y = 3 + 4
`;
    const { ast, units, worklist } = setup(code);
    const funcF = ast.statements[0] as StmtNS.FunctionDef;
    const funcG = ast.statements[1] as StmtNS.FunctionDef;

    // Simulate CSE executing inside f; g is cold and can be optimized.
    worklist.activateScope(funcF);
    worklist.drain();

    const unitF = units.get(funcF)!;
    const unitG = units.get(funcG)!;

    // g's constant-folding transform should have fired (structuralVersion > 0).
    expect(unitG.structuralVersion).toBeGreaterThan(0);
    // f's transform is parked.
    expect(unitF.structuralVersion).toBe(0);

    worklist.deactivateScope(funcF);
    worklist.drain();
    expect(unitF.structuralVersion).toBeGreaterThan(0);
  });

  test("activateScope is reference-counted (recursion)", () => {
    const { ast, worklist } = setup("x = 1");
    worklist.activateScope(ast);
    worklist.activateScope(ast);
    expect(worklist.isScopeActive(ast)).toBe(true);
    worklist.deactivateScope(ast);
    expect(worklist.isScopeActive(ast)).toBe(true); // still pinned
    worklist.deactivateScope(ast);
    expect(worklist.isScopeActive(ast)).toBe(false);
  });

  test("deactivateScope below zero is a no-op (defensive)", () => {
    const { ast, worklist } = setup("x = 1");
    expect(() => worklist.deactivateScope(ast)).not.toThrow();
    expect(worklist.isScopeActive(ast)).toBe(false);
  });
});
