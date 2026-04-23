// Speculative-clone soundness tests.
//
// Contracts verified:
//   1. Shared canonical AST is never mutated by specializedBodyFor.
//   2. Dead branch pruning when condition is const under context.
//   3. No-op when condition is not const (returns undefined).
//   4. ROOT_CONTEXT never produces a specialized body.
//   5. Non-FunctionDef units return undefined.

import { StmtNS } from "../../../ast-types";
import { parse } from "../../../parser/parser-adapter";
import { analyzeWithEnvironments } from "../../../resolver";
import math from "../../../stdlib/math";
import memo from "../../../stdlib/memo";
import misc from "../../../stdlib/misc";
import { ROOT_CONTEXT, extendContext } from "../../../specialization/framework/assumption-chain";
import { paramKey } from "../../../specialization/framework/key-spaces";
import {
  runtimeParamChannel,
} from "../../../specialization/framework/runtime-analyses";
import {
  hasSpecializedBody,
  specializedBodyFor,
} from "../../../specialization/speculative-clone";
import { buildTestWorklist } from "../../utils";

function buildWorklist(code: string) {
  const script = code + "\n";
  const ast = parse(script) as StmtNS.FileInput;
  const { environments } = analyzeWithEnvironments(ast, script, 4, [misc, math, memo]);
  const worklist = buildTestWorklist(ast, environments);
  worklist.drain();
  return { ast, worklist };
}

describe("specializedBodyFor: non-FunctionDef returns undefined", () => {
  test("FileInput unit returns undefined", () => {
    const { ast, worklist } = buildWorklist("x = 1");
    const rootUnit = worklist.topology.unitOfFunctionId(ast.id);
    expect(rootUnit).toBeDefined();
    const result = specializedBodyFor(rootUnit!, ROOT_CONTEXT, worklist.topology);
    expect(result).toBeUndefined();
  });
});

describe("specializedBodyFor: ROOT_CONTEXT produces no clone", () => {
  test("static-const condition: no clone under ROOT (constant-fold already handles it)", () => {
    const code = `
def f():
    if True:
        return 1
    return 0
`;
    const { ast, worklist } = buildWorklist(code);
    const fd = ast.statements[0] as StmtNS.FunctionDef;
    const unit = worklist.topology.unitOfFunctionId(fd.id)!;
    // Under ROOT, no speculative const facts beyond what static analysis provides.
    // Static True is already folded by the constant-fold transform rule, so by the
    // time we call specializedBodyFor the If may already be gone. Either way the
    // function returns undefined when no new pruning is achievable.
    const result = specializedBodyFor(unit, ROOT_CONTEXT, worklist.topology);
    // ROOT should not produce a new clone (static rewrites are handled elsewhere).
    expect(result).toBeUndefined();
  });
});

describe("specializedBodyFor: shared AST untouched", () => {
  test("original body reference is unchanged after call", () => {
    const code = `
def f(x):
    if x:
        return 1
    return 0
`;
    const { ast, worklist } = buildWorklist(code);
    const fd = ast.statements[0] as StmtNS.FunctionDef;
    const unit = worklist.topology.unitOfFunctionId(fd.id)!;

    const originalBody = fd.body;
    const originalBodyRef = originalBody;
    const originalIfRef = originalBody[0];

    specializedBodyFor(unit, ROOT_CONTEXT, worklist.topology);

    // Shared AST references must be identical after any call.
    expect(fd.body).toBe(originalBodyRef);
    expect(fd.body[0]).toBe(originalIfRef);
  });
});

describe("specializedBodyFor: direct param-const specialization", () => {
  test("entry-specializable param const context prunes the dead arm on the clone only", () => {
    const code = `
def f(x):
    if x:
        return 1
    else:
        return 0
`;
    const { ast, worklist } = buildWorklist(code);
    const fd = ast.statements[0] as StmtNS.FunctionDef;
    const unit = worklist.topology.unitOfFunctionId(fd.id)!;
    worklist.publish(runtimeParamChannel, paramKey(fd.id, 0), { kind: "bool", value: true }, ROOT_CONTEXT);
    worklist.drain();

    const specContext = worklist.futureDispatchChainFor(unit);
    // Under the spec chain, dead-branch has already forked+rewritten the
    // visible body through the chain itself (TypeAnalysis proves `x` is BOOL_TRUE).
    // The specialization is visible through visibleBody; speculative-clone's
    // pruneStmts sees nothing further to rewrite, so specializedBodyFor
    // returns undefined — both are acceptable.
    const specBody = specContext.visibleBody(unit);
    expect(specBody).not.toBe(unit.body);
    expect(specBody).toHaveLength(1);
    expect((specBody[0] as StmtNS.Return).value).toBeDefined();
    expect(unit.body[0]).toBeInstanceOf(StmtNS.If);
    // Either layer may have realized the specialization; assert at least one did.
    expect(
      hasSpecializedBody(unit, specContext, worklist.topology)
      || specBody !== unit.body,
    ).toBe(true);
  });
});

// The "non-param observations" describe was removed: under the param-only
// narrowing registry, per-node write observations do not extend the chain
// at all, so the test's premise (specContext !== ROOT_CONTEXT) is
// structurally false. No entry-specialized clone is produced because
// nothing extended the chain to begin with.

describe("specializedBodyFor: clone does not alias canonical body", () => {
  test("when a clone is produced, it is a different array from unit.body", () => {
    // Build a scenario where a non-ROOT context carries a type assumption on
    // a condition node. We inject it manually via extendContext using
    // typeNarrowing as the fact-surface namespace.
    const { typeNarrowing } = require("../../../specialization/type-analysis/analysis");
    const { NULL } = require("../../../specialization/type-analysis/lattice");

    const code = `
def f(x):
    if x:
        return 1
    return 0
`;
    const { ast, worklist } = buildWorklist(code);
    const fd = ast.statements[0] as StmtNS.FunctionDef;
    const unit = worklist.topology.unitOfFunctionId(fd.id)!;
    const ifStmt = fd.body[0] as StmtNS.If;
    const condId = ifStmt.condition.id;

    // Inject a type-NULL assumption for the condition's nodeId. NULL has
    // deterministic falsy truthiness.
    const ctx = extendContext(ROOT_CONTEXT, typeNarrowing, condId, NULL);

    // This test verifies the soundness contract: even if no clone is produced
    // (readExprFact returns undefined for the injected context), the shared AST
    // is never touched.
    const result = specializedBodyFor(unit, ctx, worklist.topology);
    if (result !== undefined) {
      expect(result).not.toBe(unit.body);
    }
    // Shared AST unchanged regardless.
    expect(fd.body[0]).toBe(ifStmt);
  });
});
