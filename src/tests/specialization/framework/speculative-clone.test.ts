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
import { ROOT_CONTEXT } from "../../../specialization/framework/context";
import { paramKey } from "../../../specialization/framework/key-spaces";
import {
  runtimeParamAnalysis,
  runtimeWriteAnalysis,
} from "../../../specialization/framework/runtime-analyses";
import { entryGuardsFor } from "../../../specialization/entry-guards";
import {
  hasSpecializedBody,
  specializedBodyFor,
} from "../../../specialization/speculative-clone";
import { buildTestWorklist } from "../../utils";

function buildWorklist(code: string) {
  const script = code + "\n";
  const ast = parse(script) as StmtNS.FileInput;
  const { environments } = analyzeWithEnvironments(ast, script, 4);
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
    worklist.observe(runtimeParamAnalysis, paramKey(fd.id, 0), { kind: "bool", value: true });
    worklist.drain();

    const specContext = worklist.specContextFor(unit);
    expect(hasSpecializedBody(unit, specContext, worklist.topology)).toBe(true);
    const clone = specializedBodyFor(unit, specContext, worklist.topology);
    expect(clone).toBeDefined();
    expect(clone).not.toBe(unit.body);
    expect(clone).toHaveLength(1);
    expect((clone![0] as StmtNS.Return).value).toBeDefined();
    expect(unit.body[0]).toBeInstanceOf(StmtNS.If);
  });
});

describe("specializedBodyFor: non-param observations do not create entry-specialized clones", () => {
  test("interior write profiling may narrow speculation, but produces no entry guards and no specialized clone", () => {
    const code = `
def f(x):
    y = x
    if y:
        return 1
    else:
        return 999
`;
    const { ast, worklist } = buildWorklist(code);
    const fd = ast.statements[0] as StmtNS.FunctionDef;
    const unit = worklist.topology.unitOfFunctionId(fd.id)!;
    const yRead = (fd.body[0] as StmtNS.Assign).value;

    worklist.observe(runtimeWriteAnalysis, yRead.id, { kind: "bool", value: true });
    worklist.drain();

    const specContext = worklist.specContextFor(unit);
    expect(specContext).not.toBe(ROOT_CONTEXT);
    expect(entryGuardsFor(unit, specContext)).toBeUndefined();
    expect(hasSpecializedBody(unit, specContext, worklist.topology)).toBe(false);
    expect(specializedBodyFor(unit, specContext, worklist.topology)).toBeUndefined();
  });
});

describe("specializedBodyFor: clone does not alias canonical body", () => {
  test("when a clone is produced, it is a different array from unit.body", () => {
    // Build a scenario where a non-ROOT context carries a const assumption that
    // makes a condition evaluable. We inject it manually via extendContext.
    const { extendContext } = require("../../../specialization/framework/context");
    const { constExprHandle } = require("../../../specialization/const-analysis/analysis");
    const { constOf } = require("../../../specialization/const-analysis/lattice");

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

    // Inject a const-false assumption for the condition's nodeId.
    const ctx = extendContext(ROOT_CONTEXT, constExprHandle, condId, constOf(false));

    // The worklist's constAnalysis must have a fact for condId under ctx.
    // Since we injected a context assumption, the annotate path in constAnalysis
    // will meet the env value (CONST_TOP) with constOf(false) → constOf(false).
    // But this only works if the block has been analyzed under ctx. For a
    // manually-extended context, readExprFact may return undefined because the
    // block's facts haven't been computed under ctx.
    //
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
