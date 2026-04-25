// Integration: memoization × speculation chain.
//
// `memoization.test.ts` covers the rule's unit-level contract (threshold,
// purity gate, runtime cache, SVML wiring). The one interaction not
// exercised there is chain-local purity: a function whose impure branch is
// statically unreachable *only* under a speculation chain. The rule's
// `readMinimal` walk must witness purity at the chain, fork the body, and
// rewrite the fork — without touching the shared ROOT AST.

import { ExprNS, StmtNS } from "../../ast-types";
import { SVMLCompiler } from "../../engines/svml/svml-compiler";
import { SVMLInterpreter } from "../../engines/svml/svml-interpreter";
import { clearMemoCache, memoCacheSnapshot } from "../../runtime/memo";
import { makeDfaQuery } from "../../specialization";
import { makeJitObservers } from "../../specialization/observation/runtime-analyses";
import { visibleBody } from "../../specialization/speculation/assumption-bodies";
import { bodyToCompile, dispatchValid } from "../../specialization/speculation/chain-dispatch";
import type { Function } from "../../specialization/program/function";
import type { Worklist } from "../../specialization/framework/worklist";
import { setup } from "./harness/compile-pipelines";

// `runSvmlJit` in harness/jit-runners.ts returns captured stdout only; this
// test needs worklist/unit introspection to distinguish ROOT body from
// spec body, so it runs the pipeline directly.
async function runJitWithIntrospection(code: string, functionName: string) {
  const { ast, environments, worklist } = setup(code);
  worklist.drain();

  const compiler = SVMLCompiler.fromProgramUnit(
    ast,
    environments,
    makeDfaQuery(
      worklist,
      id => worklist.futureDispatchChainForNode(id),
    ),
  );
  const program = compiler.compileProgram(ast);

  const observers = makeJitObservers(worklist);
  const interpreter = new SVMLInterpreter(program, {
    dispatchCall: (scopeId, args) => {
      observers.observeScopeCall(scopeId);
      const unit = worklist.functions.get(scopeId);
      if (unit === undefined) return undefined;
      for (let i = 0; i < args.length; i++) observers.observeParamEntry(scopeId, i, args[i]);
      worklist.sweepTransforms();
      const chain = observers.currentChainFor(scopeId);
      const isRefuted = (n: Parameters<typeof worklist.isRefuted>[0]) => worklist.isRefuted(n);
      if (!dispatchValid(unit, chain, isRefuted)) return undefined;
      const body = bodyToCompile(unit, chain, worklist, isRefuted);
      if (body === unit.body) return undefined;
      return compiler.compileFunction(unit, body);
    },
    dispatchReturn: (scopeId, value) => observers.observeScopeReturn(scopeId, value),
  });
  await interpreter.execute();

  const fd = ast.statements.find(
    (s): s is StmtNS.FunctionDef =>
      s instanceof StmtNS.FunctionDef && s.name.lexeme === functionName,
  );
  if (!fd) throw new Error(`${functionName} not found`);
  const unit = worklist.functions.get(fd.id)!;
  return { fd, unit, worklist };
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

function specBody(unit: Function, worklist: Worklist): readonly StmtNS.Stmt[] {
  return visibleBody(unit, worklist.futureDispatchChainFor(unit));
}

beforeEach(clearMemoCache);

// collatz has an impure branch guarded by `x <= 0`. Type-narrowing on the
// hot-looped positive inputs kills that branch on the speculation chain
// (but not at ROOT, where `x` could still be non-positive). Memo must
// fire on the spec body and leave the shared ROOT AST alone.
test("purity witness only on speculation chain → memo fires on spec body, ROOT untouched", async () => {
  const { fd, unit, worklist } = await runJitWithIntrospection(
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
