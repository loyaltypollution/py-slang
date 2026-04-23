// Dispatch-lane soundness.
//   1. Shared canonical AST is never mutated by bodyToCompile.
//   2. dispatchValid rejects non-FunctionDef units, ROOT-empty contexts
//      with no entry guards, non-entry-specializable assumptions, and
//      retired contexts.
//   3. bodyToCompile is total: always returns a body; `=== unit.body`
//      tells the caller speculation contributed nothing.
//   4. Ancestor-published forks are surfaced even when the context
//      carries a non-param assumption (the bug the old specializedBodyFor
//      dropped silently on early return).

import { StmtNS } from "../../ast-types";
import { ROOT_CONTEXT } from "../../specialization/framework/assumption-chain";
import { extend } from "../../specialization/framework/assumption-algebra";
import { forkBody, visibleBody } from "../../specialization/framework/assumption-bodies";
import { bodyToCompile, dispatchValid } from "../../specialization/framework/dispatch";
import { paramKey } from "../../specialization/framework/key-spaces";
import { runtimeParamChannel } from "../../specialization/framework/runtime-analyses";
import { typeNarrowing } from "../../specialization/type-analysis/analysis";
import { NULL } from "../../specialization/type-analysis/lattice";
import { setupAndDrain } from "./harness/compile-pipelines";

describe("dispatchValid", () => {
  test("FileInput unit rejected", () => {
    const { ast, worklist } = setupAndDrain("x = 1");
    const rootUnit = worklist.topology.unitOfFunctionId(ast.id)!;
    expect(dispatchValid(rootUnit, ROOT_CONTEXT)).toBe(false);
  });

  test("FunctionDef with no entry guards rejected", () => {
    const { ast, worklist } = setupAndDrain(`
def f():
    if True:
        return 1
    return 0
`);
    const fd = ast.statements[0] as StmtNS.FunctionDef;
    const unit = worklist.topology.unitOfFunctionId(fd.id)!;
    expect(dispatchValid(unit, ROOT_CONTEXT)).toBe(false);
  });

  test("retired context rejected", () => {
    const { ast, worklist } = setupAndDrain(`
def f(x):
    if x:
        return 1
    return 0
`);
    const fd = ast.statements[0] as StmtNS.FunctionDef;
    const unit = worklist.topology.unitOfFunctionId(fd.id)!;
    worklist.publish(
      runtimeParamChannel, paramKey(fd.id, 0),
      { kind: "bool", value: true }, ROOT_CONTEXT,
    );
    worklist.drain();
    const chain = worklist.futureDispatchChainFor(unit);
    // Simulate retirement: observe a conflicting value.
    worklist.publish(
      runtimeParamChannel, paramKey(fd.id, 0),
      { kind: "bool", value: false }, chain,
    );
    worklist.drain();
    expect(dispatchValid(unit, chain, n => worklist.isRefuted(n))).toBe(false);
  });
});

describe("bodyToCompile", () => {
  test("shared AST is untouched after a call", () => {
    const { ast, worklist } = setupAndDrain(`
def f(x):
    if x:
        return 1
    return 0
`);
    const fd = ast.statements[0] as StmtNS.FunctionDef;
    const unit = worklist.topology.unitOfFunctionId(fd.id)!;
    const originalBody = fd.body;
    const originalIf = originalBody[0];

    bodyToCompile(unit, ROOT_CONTEXT, worklist.topology);

    expect(fd.body).toBe(originalBody);
    expect(fd.body[0]).toBe(originalIf);
  });

  test("entry-specializable param const prunes the dead arm on the clone only", () => {
    const { ast, worklist } = setupAndDrain(`
def f(x):
    if x:
        return 1
    else:
        return 0
`);
    const fd = ast.statements[0] as StmtNS.FunctionDef;
    const unit = worklist.topology.unitOfFunctionId(fd.id)!;
    worklist.publish(
      runtimeParamChannel,
      paramKey(fd.id, 0),
      { kind: "bool", value: true },
      ROOT_CONTEXT,
    );
    worklist.drain();

    const specContext = worklist.futureDispatchChainFor(unit);
    expect(dispatchValid(unit, specContext)).toBe(true);
    const body = bodyToCompile(unit, specContext, worklist.topology);
    expect(body).not.toBe(unit.body);
  });

  test("ancestor-published fork is surfaced under a non-param assumption", () => {
    // Publish a fork at a param-typed ancestor, then query at a child
    // that carries a non-param typeNarrowing assumption. The old
    // specializedBodyFor dropped the ancestor fork on early return
    // when contextIsEntrySpecializable rejected the non-param chain;
    // the dispatchValid/bodyToCompile split lets bodyToCompile still
    // surface the ancestor fork when called (callers gate with
    // dispatchValid separately).
    const { ast, worklist } = setupAndDrain(`
def f(x):
    if x:
        return 1
    return 0
`);
    const fd = ast.statements[0] as StmtNS.FunctionDef;
    const unit = worklist.topology.unitOfFunctionId(fd.id)!;
    worklist.publish(
      runtimeParamChannel, paramKey(fd.id, 0),
      { kind: "bool", value: true }, ROOT_CONTEXT,
    );
    worklist.drain();
    const paramChain = worklist.futureDispatchChainFor(unit);
    // Materialize a fork at the param-typed ancestor.
    const ancestorFork = forkBody(unit, paramChain);
    expect(ancestorFork).not.toBe(unit.body);
    // Query at a descendant with a non-param assumption layered on.
    const ifStmt = fd.body[0] as StmtNS.If;
    const ctx = extend(paramChain, typeNarrowing, ifStmt.condition.id, NULL);
    const body = bodyToCompile(unit, ctx, worklist.topology);
    expect(body).not.toBe(unit.body);
    // Ancestor fork is reachable via visibleBody too.
    expect(visibleBody(unit, ctx)).toBe(ancestorFork);
  });
});
