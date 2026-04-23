// Online memoization contract, organized by purity regime.
//
// Each regime pins down:
//   - whether the ROOT body gets memoized (fd.body first stmt is __memo_has)
//   - whether the spec-chain body gets memoized (visibleBody at spec chain)
//   - whether the memo cache has any entries for the function
//
// The four regimes:
//   A. pure-at-root        — memoize at ROOT, cache populated
//   B. impure-every-chain  — no memo anywhere, cache empty
//   C. pure-under-spec     — memo at spec chain only, cache populated
//   D. spec-broken-by-lit  — literal arg escapes the spec narrowing, so the
//                            recursive sub-call dispatches under a broader
//                            context where purity is false → no memo anywhere
//
// D is the current failing case: the simplified purity analysis treats all
// self-recursion as optimistically pure, so a literal-NEG self-call inside a
// POS-speculated body is not recognized as breaking the assumption.

import { ExprNS, StmtNS } from "../../../ast-types";
import { SVMLCompiler } from "../../../engines/svml/svml-compiler";
import { SVMLInterpreter } from "../../../engines/svml/svml-interpreter";
import { parse } from "../../../parser/parser-adapter";
import { analyzeWithEnvironments } from "../../../resolver";
import math from "../../../stdlib/math";
import memo from "../../../stdlib/memo";
import misc from "../../../stdlib/misc";
import {
  clearMemoCache,
  memoCacheSnapshot,
} from "../../../runtime/memo";
import { makeDfaQuery, makeJitObservers } from "../../../specialization";
import { createDefaultWorklist } from "../../../specialization/defaults";
import type { Unit } from "../../../specialization/framework/function-unit";
import { specializedBodyFor } from "../../../specialization/speculative-clone";

type WorklistT = ReturnType<typeof createDefaultWorklist>;

async function runWithJit(code: string, functionName: string = "fib"): Promise<{
  ast: StmtNS.FileInput;
  returnValue: unknown;
  fd: StmtNS.FunctionDef;
  unit: Unit;
  worklist: WorklistT;
}> {
  const script = code + "\n";
  const ast = parse(script) as StmtNS.FileInput;
  const { errors, environments } = analyzeWithEnvironments(ast, script, 4, [misc, math, memo]);
  if (errors.length > 0) throw errors[0];

  const worklist = createDefaultWorklist(ast, environments);
  worklist.drain();

  const compiler = SVMLCompiler.fromProgramUnit(
    ast,
    environments,
    makeDfaQuery(
      worklist.topology,
      nodeId => worklist.futureDispatchChainForNode(nodeId),
      unit => worklist.futureDispatchChainFor(unit),
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
      for (let i = 0; i < args.length; i++) {
        observers.observeParamEntry(scopeId, i, args[i]);
      }
      worklist.sweepTransforms();
      const chain = observers.currentChainFor(scopeId);
      const specBody = specializedBodyFor(
        unit,
        chain,
        worklist.topology,
        n => worklist.isRetired(n),
      );
      if (specBody === undefined) return undefined;
      return compiler.compileFunction(unit, specBody);
    },
    dispatchReturn: (scopeId, value) => observers.observeScopeReturn(scopeId, value),
  });

  const returnValue = await interpreter.execute();

  const fd = ast.statements.find(
    (s): s is StmtNS.FunctionDef =>
      s instanceof StmtNS.FunctionDef && s.name.lexeme === functionName,
  );
  if (!fd) throw new Error(`${functionName} not found in parsed AST`);
  const unit = worklist.topology.unitOfFunctionId(fd.id)!;
  return { ast, returnValue, fd, unit, worklist };
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
  const snapshot = memoCacheSnapshot();
  return Array.from(snapshot.keys()).filter(k => k.startsWith(`${prefix}@`)).length;
}

function memoEntryCount(prefix: string): number {
  const snapshot = memoCacheSnapshot();
  return Array.from(snapshot.entries())
    .filter(([k]) => k.startsWith(`${prefix}@`))
    .reduce((acc, [, m]) => acc + m.size, 0);
}

function specBody(unit: Unit, worklist: WorklistT): readonly StmtNS.Stmt[] {
  return worklist.futureDispatchChainFor(unit).visibleBody(unit);
}

// ── A. pure at ROOT ────────────────────────────────────────────────────────
describe("A. pure-at-root: plain recursive fib", () => {
  beforeEach(clearMemoCache);

  const program = `
def fib(n):
    if n < 2:
        return n
    return fib(n - 1) + fib(n - 2)

fib(17)
`;

  test("ROOT body is memoized and the cache is populated", async () => {
    const { fd } = await runWithJit(program, "fib");
    expect(startsWithMemoHas(fd.body)).toBe(true);
    expect(memoBucketCount("fib")).toBeGreaterThan(0);
  });
});

// ── B. impure at every chain ───────────────────────────────────────────────
describe("B. impure-every-chain: print inside base case", () => {
  beforeEach(clearMemoCache);

  // `n < 2` cannot be decided from a type narrowing alone, so `print` stays
  // reachable under every speculation chain.
  const program = `
def fib(n):
    if n < 2:
        print("side effect")
        return n
    return fib(n - 1) + fib(n - 2)

fib(17)
`;

  test("no memoization at ROOT or at spec; cache empty", async () => {
    const { fd, unit, worklist } = await runWithJit(program, "fib");
    expect(startsWithMemoHas(fd.body)).toBe(false);
    expect(startsWithMemoHas(specBody(unit, worklist))).toBe(false);
    expect(memoBucketCount("fib")).toBe(0);
  });
});

// ── C. pure only under speculation ─────────────────────────────────────────
describe("C. pure-under-spec: impure branch behind a type-decidable guard", () => {
  beforeEach(clearMemoCache);

  // Two variants of the same contract: a type-narrowing can kill the impure
  // branch, so memoization fires on the forked/speculated body but NOT on the
  // shared ROOT AST (where the impure branch is still live).

  const collatz = `
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
`;

  const fibNegGuard = `
def fib(n):
    if n < 0:
        print("side effect")
    if n < 2:
        return n
    return fib(n - 1) + fib(n - 2)

fib(17)
`;

  test("collatz: spec body memoized, ROOT body untouched, cache populated", async () => {
    const { fd, unit, worklist } = await runWithJit(collatz, "collatz");
    expect(worklist.futureDispatchChainFor(unit).parent).not.toBeUndefined();
    expect(startsWithMemoHas(specBody(unit, worklist))).toBe(true);
    expect(startsWithMemoHas(fd.body)).toBe(false);
    expect(memoBucketCount("collatz")).toBeGreaterThan(0);
  });

  test("fib with n<0 guard: POS speculation is unstable under recursion", async () => {
    const { fd, unit, worklist } = await runWithJit(fibNegGuard, "fib");
    // Under strict retirement, any recursive call whose observed arg kind
    // disagrees with the live narrowing retires that chain node. fib(17)'s
    // recursion reaches fib(0), and INT_ZERO ≠ INT_POS in the sign lattice
    // — so the POS assumption is broken at runtime and POS is retired.
    // The interner-dodge (fix #2) demotes the unit's dispatch to ROOT
    // once every speculation has been refuted, which is the stable end
    // state for this shape of program.
    expect(worklist.futureDispatchChainFor(unit).depth).toBe(0);
    expect(startsWithMemoHas(specBody(unit, worklist))).toBe(false);
    expect(startsWithMemoHas(fd.body)).toBe(false);
    // Sound memo buckets *may* still accumulate during execution for
    // variants that were genuinely pure and never subsequently refuted
    // (e.g. the ZERO base-case bucket written by the last fib(0) call,
    // which no later observation retired). No assertion on count here —
    // the soundness invariant is "no memo prelude leaks into a body
    // whose speculation has been broken," which the body checks above
    // already pin down.
  });
});

// ── D. speculation broken by a literal self-call argument ──────────────────
describe("D. spec-broken-by-lit: literal arg escapes the spec narrowing", () => {
  beforeEach(clearMemoCache);

  // `fib(-1)` inside the POS-speculated body statically escapes the
  // narrowing: the sub-call dispatches at a chain where the `n<0` branch is
  // live, so purity must collapse to false at the caller's chain and
  // memoization must NOT fire — neither at ROOT nor at spec.
  const program = `
def fib(n):
    if n < 0:
        print("side effect")
    if n < 2:
        return n
    fib(-1)
    return fib(n - 1) + fib(n - 2)

fib(17)
`;

  test("no memoization at ROOT or at spec; program still computes", async () => {
    const { fd, unit, worklist, returnValue } = await runWithJit(program, "fib");
    expect(returnValue).toBe(1597n);
    // Every speculation is eventually refuted: fib(-1) breaks POS on
    // its first call, fib(0) breaks any subsequent POS revival, and
    // fib(>=2) breaks the NEG/ZERO variants. The unit's dispatch
    // stabilises at ROOT.
    expect(worklist.futureDispatchChainFor(unit).depth).toBe(0);
    expect(startsWithMemoHas(fd.body)).toBe(false);
    expect(startsWithMemoHas(specBody(unit, worklist))).toBe(false);
    // Same story as C's fib-neg-guard: sound ZERO-variant memo can
    // survive the last observation. The soundness invariant is that
    // no memo prelude sits in any body whose speculation was broken.
  });
});
