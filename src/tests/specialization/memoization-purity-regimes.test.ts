import { ExprNS, StmtNS } from "../../ast-types";
import { SVMLCompiler } from "../../engines/svml/svml-compiler";
import { SVMLInterpreter } from "../../engines/svml/svml-interpreter";
import { clearMemoCache, memoCacheSnapshot } from "../../runtime/memo";
import { makeDfaQuery, makeJitObservers } from "../../specialization";
import { visibleBody } from "../../specialization/framework/assumption-bodies";
import { bodyToCompile, dispatchValid } from "../../specialization/framework/dispatch";
import type { Unit } from "../../specialization/framework/function-unit";
import type { Worklist } from "../../specialization/framework/worklist";
import { setup } from "./harness/compile-pipelines";

interface JitRun {
  ast: StmtNS.FileInput;
  returnValue: unknown;
  fd: StmtNS.FunctionDef;
  unit: Unit;
  worklist: Worklist;
}

async function runWithJit(code: string, functionName: string): Promise<JitRun> {
  const { ast, environments, worklist } = setup(code);
  worklist.drain();

  const compiler = SVMLCompiler.fromProgramUnit(
    ast,
    environments,
    makeDfaQuery(
      worklist.topology,
      id => worklist.futureDispatchChainForNode(id),
      u => worklist.futureDispatchChainFor(u),
    ),
    worklist.registry,
  );
  const program = compiler.compileProgram(ast);

  const observers = makeJitObservers(worklist);
  const interpreter = new SVMLInterpreter(program, {
    dispatchCall: (scopeId, args) => {
      observers.observeScopeCall(scopeId);
      const unit = worklist.topology.unitOfFunctionId(scopeId);
      if (unit === undefined) return undefined;
      for (let i = 0; i < args.length; i++) observers.observeParamEntry(scopeId, i, args[i]);
      worklist.sweepTransforms();
      const chain = observers.currentChainFor(scopeId);
      const isRetired = (n: Parameters<typeof worklist.isRetired>[0]) => worklist.isRetired(n);
      if (!dispatchValid(unit, chain, isRetired)) return undefined;
      const body = bodyToCompile(unit, chain, worklist.topology, isRetired);
      if (body === unit.body) return undefined;
      return compiler.compileFunction(unit, body);
    },
    dispatchReturn: (scopeId, value) => observers.observeScopeReturn(scopeId, value),
  });
  const returnValue = await interpreter.execute();

  const fd = ast.statements.find(
    (s): s is StmtNS.FunctionDef =>
      s instanceof StmtNS.FunctionDef && s.name.lexeme === functionName,
  );
  if (!fd) throw new Error(`${functionName} not found`);
  return {
    ast,
    returnValue,
    fd,
    unit: worklist.topology.unitOfFunctionId(fd.id)!,
    worklist,
  };
}

function startsWithMemoHas(body: readonly StmtNS.Stmt[]): boolean {
  const first = body[0];
  if (!(first instanceof StmtNS.If)) return false;
  const cond = first.condition;
  if (!(cond instanceof ExprNS.Call)) return false;
  const callee = cond.callee;
  return callee instanceof ExprNS.Variable && callee.name.lexeme === "__memo_has";
}

function memoBucketCount(prefix: string): number {
  return Array.from(memoCacheSnapshot().keys()).filter(k => k.startsWith(`${prefix}@`)).length;
}

function specBody(unit: Unit, worklist: Worklist): readonly StmtNS.Stmt[] {
  return visibleBody(unit, worklist.futureDispatchChainFor(unit));
}

beforeEach(clearMemoCache);

test("A. pure-at-root: plain recursive fib → ROOT memoized, cache populated", async () => {
  const { fd } = await runWithJit(
    `
def fib(n):
    if n < 2:
        return n
    return fib(n - 1) + fib(n - 2)

fib(17)
`,
    "fib",
  );
  expect(startsWithMemoHas(fd.body)).toBe(true);
  expect(memoBucketCount("fib")).toBeGreaterThan(0);
});

// `n < 2` can't be decided from a type narrowing alone → print stays reachable
// under every speculation chain.
test("B. impure-every-chain: no memo anywhere, cache empty", async () => {
  const { fd, unit, worklist } = await runWithJit(
    `
def fib(n):
    if n < 2:
        print("side effect")
        return n
    return fib(n - 1) + fib(n - 2)

fib(17)
`,
    "fib",
  );
  expect(startsWithMemoHas(fd.body)).toBe(false);
  expect(startsWithMemoHas(specBody(unit, worklist))).toBe(false);
  expect(memoBucketCount("fib")).toBe(0);
});

// Type-narrowing kills the impure branch → memo fires on the spec body
// but not on the shared ROOT AST.
test("C. pure-under-spec (collatz): spec body memoized, ROOT untouched", async () => {
  const { fd, unit, worklist } = await runWithJit(
    `
def collatz(x):
    if x <= 0:
        print("Input must be a positive integer.")
        return -1
    if x % 2 == 0:
        return x // 2
    else:
        return 3 * x + 1

x = 97
for i in range(20):
    x = collatz(x)
`,
    "collatz",
  );
  expect(worklist.futureDispatchChainFor(unit).parent).not.toBeUndefined();
  expect(startsWithMemoHas(specBody(unit, worklist))).toBe(true);
  expect(startsWithMemoHas(fd.body)).toBe(false);
  expect(memoBucketCount("collatz")).toBeGreaterThan(0);
});

// Under strict retirement, fib(0) breaks INT_POS and fib(>=2) breaks the
// NEG/ZERO siblings, so dispatch stabilises at ROOT with no memo prelude.
test("C. pure-under-spec (fib n<0 guard): POS unstable → dispatch stabilises at ROOT", async () => {
  const { fd, unit, worklist } = await runWithJit(
    `
def fib(n):
    if n < 0:
        print("side effect")
    if n < 2:
        return n
    return fib(n - 1) + fib(n - 2)

fib(17)
`,
    "fib",
  );
  expect(worklist.futureDispatchChainFor(unit).depth).toBe(0);
  expect(startsWithMemoHas(specBody(unit, worklist))).toBe(false);
  expect(startsWithMemoHas(fd.body)).toBe(false);
});

// fib(-1) inside the POS-speculated body statically escapes the narrowing:
// every speculation is eventually refuted, dispatch stabilises at ROOT.
test("D. spec-broken-by-lit: no memo at ROOT or spec; program still computes", async () => {
  const { fd, unit, worklist, returnValue } = await runWithJit(
    `
def fib(n):
    if n < 0:
        print("side effect")
    if n < 2:
        return n
    fib(-1)
    return fib(n - 1) + fib(n - 2)

fib(17)
`,
    "fib",
  );
  expect(returnValue).toBe(1597n);
  expect(worklist.futureDispatchChainFor(unit).depth).toBe(0);
  expect(startsWithMemoHas(fd.body)).toBe(false);
  expect(startsWithMemoHas(specBody(unit, worklist))).toBe(false);
});
