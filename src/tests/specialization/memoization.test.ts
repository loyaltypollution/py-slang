import { ExprNS, StmtNS } from "../../ast-types";
import { SVMLCompiler } from "../../engines/svml/svml-compiler";
import { SVMLInterpreter } from "../../engines/svml/svml-interpreter";
import { constAnalysis, typeAnalysis } from "../../specialization/analysis";
import { ROOT_CONTEXT } from "../../specialization/assumption/chain";
import {
  clearMemoCache,
  memoCacheSnapshot,
  memoLookup,
  MEMO_MISS,
  memoPut,
} from "../../runtime/memo";
import { runtimeCallHotness } from "../../specialization/observation/runtime-analyses";
import type { Function } from "../../specialization/program/units/function/function";
import type { Worklist } from "../../specialization/framework/worklist";
import { setup } from "./harness/compile-pipelines";
import { findFunctionDef, observeCallsTo } from "./harness/function-observe";

function dfaQueryFor(worklist: Worklist) {
  const typeStore = typeAnalysis.perExpr(worklist.locate);
  const constStore = constAnalysis.perExpr(worklist.locate);
  return {
    typeOf: (id: number) => typeStore.tryRead(id, ROOT_CONTEXT),
    constOf: (id: number) => constStore.tryRead(id, ROOT_CONTEXT),
  };
}

const MEMO_TRIGGER_CALLS = runtimeCallHotness.max - 1;

// TODO(plan.md §1): replace with `memoization.didFireOn(unit)` once the
// transform exposes a public tag; this helper pins the wrapper's private shape.
function memoFired(unit: Function): boolean {
  const fd = unit.funcAst;
  if (!(fd instanceof StmtNS.FunctionDef)) return false;
  const first = fd.body[0];
  if (!(first instanceof StmtNS.If)) return false;
  const cond = first.condition;
  if (!(cond instanceof ExprNS.Call)) return false;
  const callee = cond.callee;
  return callee instanceof ExprNS.Variable && callee.name.lexeme === "__memo_has";
}

function drainAndObserve(code: string, fnName: string, calls: number) {
  const { ast, worklist } = setup(code);
  worklist.drain();
  const fd = findFunctionDef(ast, fnName);
  observeCallsTo(worklist, fd, calls);
  worklist.drain();
  return { ast, worklist, fd };
}

describe("memoization: call-count → threshold → AST rewrite", () => {
  beforeEach(clearMemoCache);

  test("observeCall increments callCount hint", () => {
    const { ast, worklist } = setup("def f(x):\n    return x + 1");
    worklist.drain();
    const fd = findFunctionDef(ast, "f");
    expect(runtimeCallHotness.at(fd.id)).toBe(0);
    observeCallsTo(worklist, fd, 3);
    expect(runtimeCallHotness.at(fd.id)).toBe(3);
  });

  test("below threshold: body unchanged", () => {
    const { worklist, fd } = drainAndObserve(
      "def f(x):\n    return x + 1",
      "f",
      MEMO_TRIGGER_CALLS - 1,
    );
    expect(memoFired(worklist.locate.functionById(fd.id)!)).toBe(false);
    expect(fd.body).toHaveLength(1);
    expect(fd.body[0]).toBeInstanceOf(StmtNS.Return);
  });

  test("at threshold + pure: body is wrapped with __memo_has / __memo_put", () => {
    const { worklist, fd } = drainAndObserve(
      "def f(x):\n    return x + 1",
      "f",
      MEMO_TRIGGER_CALLS,
    );
    expect(memoFired(worklist.locate.functionById(fd.id)!)).toBe(true);
    expect(fd.body).toHaveLength(2);
    const guard = fd.body[0] as StmtNS.If;
    expect(((guard.condition as ExprNS.Call).callee as ExprNS.Variable).name.lexeme).toBe(
      "__memo_has",
    );
    const tail = fd.body[1] as StmtNS.Return;
    expect(((tail.value as ExprNS.Call).callee as ExprNS.Variable).name.lexeme).toBe("__memo_put");
  });

  test("idempotent: second observation past threshold does not re-wrap", () => {
    const { worklist, fd } = drainAndObserve(
      "def f(x):\n    return x + 1",
      "f",
      MEMO_TRIGGER_CALLS,
    );
    const bodyLen = fd.body.length;
    observeCallsTo(worklist, fd, MEMO_TRIGGER_CALLS);
    worklist.drain();
    expect(fd.body.length).toBe(bodyLen);
  });

  test("nested returns: every Return inside body gets __memo_put wrapped", () => {
    const code = [
      "def f(x):",
      "    if x:",
      "        while x:",
      "            return x",
      "    return 0",
    ].join("\n");
    const { fd } = drainAndObserve(code, "f", MEMO_TRIGGER_CALLS);

    const returns: StmtNS.Return[] = [];
    const walk = (stmts: StmtNS.Stmt[]) => {
      for (const s of stmts) {
        if (s instanceof StmtNS.Return) returns.push(s);
        else if (s instanceof StmtNS.If) {
          walk(s.body);
          if (s.elseBlock) walk(s.elseBlock);
        } else if (s instanceof StmtNS.While || s instanceof StmtNS.For) {
          walk(s.body);
        }
      }
    };
    walk(fd.body.slice(1));

    expect(returns.length).toBeGreaterThanOrEqual(2);
    for (const r of returns) {
      const call = r.value as ExprNS.Call;
      expect((call.callee as ExprNS.Variable).name.lexeme).toBe("__memo_put");
    }
  });
});

describe("memoization: purity gate", () => {
  beforeEach(clearMemoCache);

  test("free-name read (global) stays unwrapped past threshold", () => {
    const { worklist, fd } = drainAndObserve(
      "x = 0\ndef g():\n    return x",
      "g",
      MEMO_TRIGGER_CALLS * 2,
    );
    expect(memoFired(worklist.locate.functionById(fd.id)!)).toBe(false);
    expect(fd.body[0]).toBeInstanceOf(StmtNS.Return);
  });

  test("I/O call (print) stays unwrapped past threshold", () => {
    const { worklist, fd } = drainAndObserve(
      "def f(x):\n    print(x)\n    return x",
      "f",
      MEMO_TRIGGER_CALLS * 2,
    );
    expect(memoFired(worklist.locate.functionById(fd.id)!)).toBe(false);
    expect(fd.body).toHaveLength(2);
  });
});

describe("memoization: runtime cache contract", () => {
  beforeEach(clearMemoCache);

  test("miss on unknown id returns MEMO_MISS sentinel", () => {
    expect(memoLookup("unknown@L1", [])).toBe(MEMO_MISS);
  });

  test("miss on known id with different args", () => {
    memoPut("f@L1", [1], 10);
    expect(memoLookup("f@L1", [2])).toBe(MEMO_MISS);
  });

  test("hit returns stored value — distinguishable from miss", () => {
    memoPut("f@L1", [1, 2], 42);
    expect(memoLookup("f@L1", [1, 2])).toBe(42);
  });

  test("null and undefined stored values distinguishable from MEMO_MISS", () => {
    memoPut("f@L1", [], null);
    expect(memoLookup("f@L1", [])).toBeNull();
    memoPut("g@L1", [], undefined);
    expect(memoLookup("g@L1", [])).toBeUndefined();
  });

  test("arg-key type-tagged: (1,) and ('1',) do not collide", () => {
    memoPut("id@L1", [1], "from-number");
    memoPut("id@L1", ["1"], "from-string");
    expect(memoCacheSnapshot().get("id@L1")!.size).toBe(2);
  });

  test("zero-arg wrap puts under empty-string key", () => {
    drainAndObserve("def answer():\n    return 42", "answer", MEMO_TRIGGER_CALLS);
    memoPut("answer@L1", [], 42);
    expect(memoLookup("answer@L1", [])).not.toBe(MEMO_MISS);
    expect(Array.from(memoCacheSnapshot().get("answer@L1")!.keys())).toEqual([""]);
  });
});

describe("memoization: SVML wiring", () => {
  beforeEach(clearMemoCache);

  async function compileAndRun(code: string): Promise<void> {
    const { ast, environments, worklist } = setup(code);
    worklist.drain();
    const compiler = SVMLCompiler.fromProgramUnit(ast, environments, dfaQueryFor(worklist));
    await new SVMLInterpreter(compiler.compileProgram(ast)).execute();
    worklist.drain();
  }

  test("__memo_put writes to the shared slab", async () => {
    await compileAndRun(`__memo_put("k@L1", 5, 42)`);
    // Ints are bigint at runtime; arg-key serializer tags by typeof.
    expect(memoCacheSnapshot().get("k@L1")!.get("bigint:5")).toBe(42n);
  });

  test("wrapped function: second call with same arg hits cache", async () => {
    const { ast, environments, worklist } = setup(`
def f(x):
    return x + 1
f(5)
f(5)
`);
    worklist.drain();
    const fd = findFunctionDef(ast, "f");
    observeCallsTo(worklist, fd, MEMO_TRIGGER_CALLS);
    worklist.drain();
    expect(memoFired(worklist.locate.functionById(fd.id)!)).toBe(true);

    const compiler = SVMLCompiler.fromProgramUnit(ast, environments, dfaQueryFor(worklist));
    await new SVMLInterpreter(compiler.compileProgram(ast)).execute();

    const fBuckets = Array.from(memoCacheSnapshot().entries()).filter(([k]) => k.startsWith("f@"));
    expect(fBuckets).toHaveLength(1);
    const [, bucket] = fBuckets[0];
    expect(bucket.size).toBe(1);
    expect(bucket.get("bigint:5")).toBe(6n);
  });

  test("__memo_has + __memo_get survive a round trip", async () => {
    await compileAndRun(`
__memo_put("k@L1", 1, 7)
__memo_put("k@L1", 2, __memo_get("k@L1", 1))
`);
    const bucket = memoCacheSnapshot().get("k@L1")!;
    expect(bucket.get("bigint:1")).toBe(7n);
    expect(bucket.get("bigint:2")).toBe(7n);
  });
});
