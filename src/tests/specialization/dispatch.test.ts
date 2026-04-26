import { StmtNS } from "../../ast-types";
import { ROOT_CONTEXT } from "../../specialization/assumption/chain";
import { bodyToCompile, dispatchValid } from "../../specialization/speculation/chain-dispatch";
import { paramKey } from "../../specialization/narrowing-policy/param-key";
import { runtimeParamSource } from "../../specialization/observation/runtime-analyses";
import { setupAndDrain } from "./harness/compile-pipelines";

describe("dispatchValid", () => {
  test("FileInput function rejected", () => {
    const { ast, worklist } = setupAndDrain("x = 1");
    const rootFunction = worklist.locate.functionById(ast.id)!;
    expect(dispatchValid(rootFunction, ROOT_CONTEXT)).toBe(false);
  });

  test("FunctionDef with no entry guards rejected", () => {
    const { ast, worklist } = setupAndDrain(`
def f():
    if True:
        return 1
    return 0
`);
    const fd = ast.statements[0] as StmtNS.FunctionDef;
    const function = worklist.locate.functionById(fd.id)!;
    expect(dispatchValid(function, ROOT_CONTEXT)).toBe(false);
  });

  test("retired context rejected", () => {
    const { ast, worklist } = setupAndDrain(`
def f(x):
    if x:
        return 1
    return 0
`);
    const fd = ast.statements[0] as StmtNS.FunctionDef;
    const function = worklist.locate.functionById(fd.id)!;
    worklist.observe(
      runtimeParamSource,
      paramKey(fd.id, 0),
      { kind: "bool", value: true },
      ROOT_CONTEXT,
    );
    worklist.drain();
    const chain = worklist.futureDispatchChainFor(function);
    // Simulate retirement: observe a conflicting value.
    worklist.observe(runtimeParamSource, paramKey(fd.id, 0), { kind: "bool", value: false }, chain);
    worklist.drain();
    expect(dispatchValid(function, chain, n => worklist.isRefuted(n))).toBe(false);
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
    const function = worklist.locate.functionById(fd.id)!;
    const originalBody = fd.body;
    const originalIf = originalBody[0];

    worklist.observe(
      runtimeParamSource,
      paramKey(fd.id, 0),
      { kind: "bool", value: true },
      ROOT_CONTEXT,
    );
    worklist.drain();

    const specContext = worklist.futureDispatchChainFor(function);
    expect(dispatchValid(function, specContext)).toBe(true);
    const body = bodyToCompile(function, specContext, worklist.locate);
    expect(body).not.toBe(function.body);
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
    const function = worklist.locate.functionById(fd.id)!;
    // ROOT_CONTEXT has no entry guards → dispatchValid === false.
    expect(() => bodyToCompile(function, ROOT_CONTEXT, worklist.locate)).toThrow(
      /dispatchValid.*must hold/,
    );
  });
});
