import { ExprNS, StmtNS } from "../../../ast-types";
import { parse } from "../../../parser/parser-adapter";
import { analyzeWithEnvironments } from "../../../resolver";
import { MEMOIZATION_THRESHOLD } from "../../../specialization/transforms/memoization";
import {
  clearMemoCache,
  memoCacheSnapshot,
  memoLookup,
  MEMO_MISS,
  memoPut,
} from "../../../runtime/memo";
import { runtimeCallAnalysis } from "../../../specialization/framework/runtime-analyses";
import type { Unit } from "../../../specialization/framework/function-unit";
import type { Worklist } from "../../../specialization/framework/worklist";
import { SVMLCompiler } from "../../../engines/svml/svml-compiler";
import { makeDfaQuery } from "../../../specialization";
import { SVMLInterpreter } from "../../../engines/svml/svml-interpreter";
import { buildTestWorklist } from "../../utils";

function setup(code: string) {
  const script = code + "\n";
  const ast = parse(script) as StmtNS.FileInput;
  const { environments } = analyzeWithEnvironments(ast, script, 4);
  const reactive = buildTestWorklist(ast, environments);
  return { ast, reactive };
}

function findFunctionDef(ast: StmtNS.FileInput, name: string): StmtNS.FunctionDef {
  for (const s of ast.statements) {
    if (s instanceof StmtNS.FunctionDef && s.name.lexeme === name) return s;
  }
  throw new Error(`FunctionDef ${name} not found`);
}

function observeCallsTo(reactive: Worklist, fd: StmtNS.FunctionDef, n: number): void {
  for (let i = 1; i <= n; i++) reactive.observe(runtimeCallAnalysis, fd.id, i);
}

function memoFired(_reactive: Worklist, unit: Unit): boolean {
  const fd = unit.funcAst;
  if (!(fd instanceof StmtNS.FunctionDef)) return false;
  const first = fd.body[0];
  if (!(first instanceof StmtNS.If)) return false;
  const cond = first.condition;
  if (!(cond instanceof ExprNS.Call)) return false;
  const callee = cond.callee;
  return callee instanceof ExprNS.Variable && callee.name.lexeme === "__memo_has";
}

describe("memoization: call-count → threshold → AST rewrite", () => {
  beforeEach(clearMemoCache);

  test("observeCall increments callCount hint", () => {
    const { ast, reactive } = setup("def f(x):\n    return x + 1");
    reactive.drain();
    const fd = findFunctionDef(ast, "f");
    expect(reactive.tryRead(runtimeCallAnalysis, fd.id)).toBeUndefined();
    observeCallsTo(reactive, fd, 3);
    expect(reactive.tryRead(runtimeCallAnalysis, fd.id)).toBe(3);
  });

  test("below threshold: body unchanged", () => {
    const { ast, reactive } = setup("def f(x):\n    return x + 1");
    reactive.drain();
    const fd = findFunctionDef(ast, "f");
    observeCallsTo(reactive, fd, MEMOIZATION_THRESHOLD - 1);
    reactive.drain();
    expect(memoFired(reactive, reactive.units.get(fd.id)!)).toBe(false);
    expect(fd.body).toHaveLength(1);
    expect(fd.body[0]).toBeInstanceOf(StmtNS.Return);
  });

  test("at threshold + pure: body is wrapped with __memo_has / __memo_put", () => {
    const { ast, reactive } = setup("def f(x):\n    return x + 1");
    reactive.drain();
    const fd = findFunctionDef(ast, "f");
    observeCallsTo(reactive, fd, MEMOIZATION_THRESHOLD);
    reactive.drain();

    expect(memoFired(reactive, reactive.units.get(fd.id)!)).toBe(true);
    expect(fd.body).toHaveLength(2);

    const guard = fd.body[0] as StmtNS.If;
    const hasCall = guard.condition as ExprNS.Call;
    expect((hasCall.callee as ExprNS.Variable).name.lexeme).toBe("__memo_has");

    const tail = fd.body[1] as StmtNS.Return;
    const putCall = tail.value as ExprNS.Call;
    expect((putCall.callee as ExprNS.Variable).name.lexeme).toBe("__memo_put");
  });

  test("idempotent: second observation past threshold does not re-wrap", () => {
    const { ast, reactive } = setup("def f(x):\n    return x + 1");
    reactive.drain();
    const fd = findFunctionDef(ast, "f");
    observeCallsTo(reactive, fd, MEMOIZATION_THRESHOLD);
    reactive.drain();
    const bodyLen = fd.body.length;
    observeCallsTo(reactive, fd, MEMOIZATION_THRESHOLD);
    reactive.drain();
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
    const { ast, reactive } = setup(code);
    reactive.drain();
    const fd = findFunctionDef(ast, "f");
    observeCallsTo(reactive, fd, MEMOIZATION_THRESHOLD);
    reactive.drain();

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
    const { ast, reactive } = setup("x = 0\ndef g():\n    return x");
    reactive.drain();
    const fd = findFunctionDef(ast, "g");
    observeCallsTo(reactive, fd, MEMOIZATION_THRESHOLD * 2);
    reactive.drain();
    expect(memoFired(reactive, reactive.units.get(fd.id)!)).toBe(false);
    expect(fd.body[0]).toBeInstanceOf(StmtNS.Return);
  });

  test("I/O call (print) stays unwrapped past threshold", () => {
    const { ast, reactive } = setup("def f(x):\n    print(x)\n    return x");
    reactive.drain();
    const fd = findFunctionDef(ast, "f");
    observeCallsTo(reactive, fd, MEMOIZATION_THRESHOLD * 2);
    reactive.drain();
    expect(memoFired(reactive, reactive.units.get(fd.id)!)).toBe(false);
    expect(fd.body).toHaveLength(2);
  });
});

// Runtime side-table: contract of memoLookup/memoPut, type-tagged arg keys,
// and that a zero-arg function's key collapses to empty string.
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
    const snap = memoCacheSnapshot().get("id@L1")!;
    expect(snap.size).toBe(2);
  });

  test("zero-arg wrap puts under empty-string key", () => {
    const { ast, reactive } = setup("def answer():\n    return 42");
    reactive.drain();
    const fd = findFunctionDef(ast, "answer");
    observeCallsTo(reactive, fd, MEMOIZATION_THRESHOLD);
    reactive.drain();

    memoPut("answer@L1", [], 42);
    expect(memoLookup("answer@L1", [])).not.toBe(MEMO_MISS);
    expect(Array.from(memoCacheSnapshot().get("answer@L1")!.keys())).toEqual([""]);
  });
});

// SVML integration: resolver seeds __memo_* names, compiler routes to primitives,
// interpreter dispatches to the shared runtime.
describe("memoization: SVML wiring", () => {
  beforeEach(clearMemoCache);

  function runSvml(code: string) {
    const script = code + "\n";
    const ast = parse(script) as StmtNS.FileInput;
    const { environments } = analyzeWithEnvironments(ast, script, 4);
    const reactive = buildTestWorklist(ast, environments);
    reactive.drain();
    const compiler = SVMLCompiler.fromProgramUnit(
      ast,
      environments,
      makeDfaQuery(reactive.topology),
      reactive.registry,
    );
    const interpreter = new SVMLInterpreter(compiler.compileProgram(ast));
    return { reactive, interpreter };
  }

  test("__memo_put writes to the shared slab", async () => {
    const { reactive, interpreter } = runSvml(`__memo_put("k@L1", 5, 42)`);
    await interpreter.execute();
    reactive.drain();
    expect(memoCacheSnapshot().get("k@L1")!.get("number:5")).toBe(42);
  });

  test("wrapped function: second call with same arg hits cache", async () => {
    const code = `
def f(x):
    return x + 1
f(5)
f(5)
`;
    const script = code + "\n";
    const ast = parse(script) as StmtNS.FileInput;
    const { environments } = analyzeWithEnvironments(ast, script, 4);
    const reactive = buildTestWorklist(ast, environments);
    reactive.drain();

    // Trip the memoization rewrite before compilation.
    const fd = findFunctionDef(ast, "f");
    observeCallsTo(reactive, fd, MEMOIZATION_THRESHOLD);
    reactive.drain();
    expect(memoFired(reactive, reactive.units.get(fd.id)!)).toBe(true);

    const compiler = SVMLCompiler.fromProgramUnit(
      ast,
      environments,
      makeDfaQuery(reactive.topology),
      reactive.registry,
    );
    const interpreter = new SVMLInterpreter(compiler.compileProgram(ast));
    await interpreter.execute();

    // Cache must contain exactly one entry for f keyed by x=5.
    // Two calls with identical args → a cache hit on the second, so the
    // bucket has a single (number:5 → 6) pair, not two.
    const buckets = memoCacheSnapshot();
    const fBuckets = Array.from(buckets.entries()).filter(([k]) => k.startsWith("f@"));
    expect(fBuckets).toHaveLength(1);
    const [, bucket] = fBuckets[0];
    expect(bucket.size).toBe(1);
    expect(bucket.get("number:5")).toBe(6);
  });

  test("__memo_has + __memo_get survive a round trip", async () => {
    const { reactive, interpreter } = runSvml(`
__memo_put("k@L1", 1, 7)
__memo_put("k@L1", 2, __memo_get("k@L1", 1))
`);
    await interpreter.execute();
    reactive.drain();
    const bucket = memoCacheSnapshot().get("k@L1")!;
    expect(bucket.get("number:1")).toBe(7);
    expect(bucket.get("number:2")).toBe(7);
  });
});
