import { StmtNS } from "../../ast-types";
import { ROOT_CONTEXT } from "../../specialization/assumption/chain";
import { bodyToCompile, dispatchValid } from "../../specialization/speculation/chain-dispatch";
import { paramKey } from "../../specialization/program/function-keys";
import { runtimeParamChannel } from "../../specialization/observation/runtime-analyses";
import { setupAndDrain } from "./harness/compile-pipelines";

describe("dispatchValid", () => {
  test("FileInput unit rejected", () => {
    const { ast, worklist } = setupAndDrain("x = 1");
    const rootUnit = worklist.functions.get(ast.id)!;
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
    const unit = worklist.functions.get(fd.id)!;
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
    const unit = worklist.functions.get(fd.id)!;
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
  test("entry-specializable param const prunes the dead arm without mutating the canonical AST", () => {
    const { ast, worklist } = setupAndDrain(`
def f(x):
    if x:
        return 1
    else:
        return 0
`);
    const fd = ast.statements[0] as StmtNS.FunctionDef;
    const unit = worklist.functions.get(fd.id)!;
    const originalBody = fd.body;
    const originalIf = originalBody[0];

    worklist.publish(
      runtimeParamChannel,
      paramKey(fd.id, 0),
      { kind: "bool", value: true },
      ROOT_CONTEXT,
    );
    worklist.drain();

    const specContext = worklist.futureDispatchChainFor(unit);
    expect(dispatchValid(unit, specContext)).toBe(true);
    const body = bodyToCompile(unit, specContext, worklist);
    expect(body).not.toBe(unit.body);
    // Shared AST is untouched — the pruned body is a clone.
    expect(fd.body).toBe(originalBody);
    expect(fd.body[0]).toBe(originalIf);
  });

  test("precondition: throws when dispatchValid would reject", () => {
    const { ast, worklist } = setupAndDrain(`
def f(x):
    if x:
        return 1
    return 0
`);
    const fd = ast.statements[0] as StmtNS.FunctionDef;
    const unit = worklist.functions.get(fd.id)!;
    // ROOT_CONTEXT has no entry guards → dispatchValid === false.
    expect(() => bodyToCompile(unit, ROOT_CONTEXT, worklist))
      .toThrow(/dispatchValid.*must hold/);
  });
});
