/**
 * End-to-end test for CallCountObserver + MemoizationTransformRule.
 *
 * Exercises the whole observation → hint-accumulation → transform chain:
 *   1. `observeCall` fires N times on a FunctionDef; the analysis increments
 *      the callCount hint on the callee.
 *   2. When the count crosses MEMOIZATION_THRESHOLD and the body is pure,
 *      MemoizationTransformRule rewrites the body with the __memo_has /
 *      __memo_put prelude. The transform fires on `tick()` after the root
 *      scope is unpinned.
 *   3. Impure functions stay unwrapped regardless of call count (the purity
 *      gate is the only reason a hot function would be skipped).
 */

import { ExprNS, StmtNS } from "../ast-types";
import { parse } from "../parser/parser-adapter";
import { analyzeWithEnvironments } from "../resolver";
import {
  clearMemoCache,
  MEMOIZATION_THRESHOLD,
  CALL_COUNT_FIELD,
  MEMOIZED_FIELD,
  memoCacheSnapshot,
  memoLookup,
  MEMO_MISS,
  memoPut,
} from "../specialization";
import { buildTestWorklist } from "./utils";

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

describe("CallCountObserver + transform", () => {
  beforeEach(() => clearMemoCache());

  test("observeCall bumps the callCount hint on the callee FunctionDef", () => {
    const { ast, reactive } = setup("def f(x):\n    return x + 1");
    reactive.converge();
    const fd = findFunctionDef(ast, "f");
    const calleeUnit = reactive.units.get(fd)!;

    expect(calleeUnit.hints.get(fd)?.[CALL_COUNT_FIELD]).toBeUndefined();

    for (let i = 0; i < 3; i++) reactive.observeCall(ast, fd);
    expect(calleeUnit.hints.get(fd)?.[CALL_COUNT_FIELD]).toBe(3);
  });

  test("below threshold: no transform", () => {
    const { ast, reactive } = setup("def f(x):\n    return x + 1");
    reactive.converge();
    const fd = findFunctionDef(ast, "f");

    for (let i = 0; i < MEMOIZATION_THRESHOLD - 1; i++) reactive.observeCall(ast, fd);
    reactive.tick();

    expect(reactive.units.get(fd)!.hints.get(fd)?.[MEMOIZED_FIELD]).toBeFalsy();
    // Body is still just the original return.
    expect(fd.body.length).toBe(1);
    expect(fd.body[0]).toBeInstanceOf(StmtNS.Return);
  });

  test("at/above threshold + pure: transform rewrites body with memo prelude", () => {
    const { ast, reactive } = setup("def f(x):\n    return x + 1");
    reactive.converge();
    const fd = findFunctionDef(ast, "f");

    for (let i = 0; i < MEMOIZATION_THRESHOLD; i++) reactive.observeCall(ast, fd);
    reactive.tick();

    // Memoized hint set on the FunctionDef.
    expect(reactive.units.get(fd)!.hints.get(fd)?.[MEMOIZED_FIELD]).toBe(true);

    // Body now starts with `if __memo_has(...): return __memo_get(...)`.
    expect(fd.body.length).toBe(2);
    const firstStmt = fd.body[0];
    expect(firstStmt).toBeInstanceOf(StmtNS.If);
    const ifStmt = firstStmt as StmtNS.If;
    expect(ifStmt.condition).toBeInstanceOf(ExprNS.Call);
    const hasCall = ifStmt.condition as ExprNS.Call;
    expect((hasCall.callee as ExprNS.Variable).name.lexeme).toBe("__memo_has");

    // The original `return x + 1` now returns `__memo_put(id, x, x+1)`.
    const tail = fd.body[1] as StmtNS.Return;
    expect(tail.value).toBeInstanceOf(ExprNS.Call);
    const putCall = tail.value as ExprNS.Call;
    expect((putCall.callee as ExprNS.Variable).name.lexeme).toBe("__memo_put");
  });

  test("transform does not re-fire once memoized (idempotent)", () => {
    const { ast, reactive } = setup("def f(x):\n    return x + 1");
    reactive.converge();
    const fd = findFunctionDef(ast, "f");

    for (let i = 0; i < MEMOIZATION_THRESHOLD; i++) reactive.observeCall(ast, fd);
    reactive.tick();
    const bodyLenAfterFirst = fd.body.length;

    for (let i = 0; i < MEMOIZATION_THRESHOLD; i++) reactive.observeCall(ast, fd);
    reactive.tick();

    expect(fd.body.length).toBe(bodyLenAfterFirst);
    // Only one memo prelude on the front, not two.
    const firstCall = ((fd.body[0] as StmtNS.If).condition) as ExprNS.Call;
    expect((firstCall.callee as ExprNS.Variable).name.lexeme).toBe("__memo_has");
    const inner = fd.body[1];
    // The second statement must not itself be another memo prelude.
    if (inner instanceof StmtNS.If) {
      const innerCall = inner.condition;
      if (innerCall instanceof ExprNS.Call) {
        const calleeName = (innerCall.callee as ExprNS.Variable).name.lexeme;
        expect(calleeName).not.toBe("__memo_has");
      }
    }
  });

  test("zero-arg function: wraps and argKey collapses to the empty string", () => {
    const { ast, reactive } = setup("def answer():\n    return 42");
    reactive.converge();
    const fd = findFunctionDef(ast, "answer");

    for (let i = 0; i < MEMOIZATION_THRESHOLD; i++) reactive.observeCall(ast, fd);
    reactive.tick();

    expect(reactive.units.get(fd)!.hints.get(fd)?.[MEMOIZED_FIELD]).toBe(true);
    expect(fd.body[0]).toBeInstanceOf(StmtNS.If);

    // Runtime slab with empty args: one entry keyed on "" after a put.
    memoPut("answer@L1", [], 42);
    expect(memoLookup("answer@L1", [])).not.toBe(MEMO_MISS);
    const snap = memoCacheSnapshot().get("answer@L1")!;
    expect(Array.from(snap.keys())).toEqual([""]);
  });

  test("nested return inside if / while / for is rewritten", () => {
    const code = [
      "def f(x):",
      "    if x:",
      "        while x:",
      "            return x",
      "    return 0",
    ].join("\n");
    const { ast, reactive } = setup(code);
    reactive.converge();
    const fd = findFunctionDef(ast, "f");

    for (let i = 0; i < MEMOIZATION_THRESHOLD; i++) reactive.observeCall(ast, fd);
    reactive.tick();

    // Collect all Return nodes in the wrapped body (skipping the prelude's
    // own Return, which is inside the synthetic If at body[0]).
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

    // Every non-prelude return should now wrap its value in __memo_put(...).
    expect(returns.length).toBeGreaterThanOrEqual(2);
    for (const r of returns) {
      expect(r.value).toBeInstanceOf(ExprNS.Call);
      const callee = (r.value as ExprNS.Call).callee as ExprNS.Variable;
      expect(callee.name.lexeme).toBe("__memo_put");
    }
  });

  test("global-read function is rejected by the purity gate", () => {
    // `g` reads the free name `x` (not a parameter, not a varDecl).
    // After Fix 1 this must be classified impure and left unwrapped.
    const { ast, reactive } = setup("x = 0\ndef g():\n    return x");
    reactive.converge();
    const fd = findFunctionDef(ast, "g");

    for (let i = 0; i < MEMOIZATION_THRESHOLD * 2; i++) reactive.observeCall(ast, fd);
    reactive.tick();

    expect(reactive.units.get(fd)!.hints.get(fd)?.[MEMOIZED_FIELD]).toBeFalsy();
    expect(fd.body[0]).toBeInstanceOf(StmtNS.Return);
  });

  test("arg-key does not collide across types", () => {
    // Direct regression guard on runtime.argKey (Fix 2). Prior behavior
    // stringified without a type tag, so (1,) and ("1",) collided.
    memoPut("id@L1", [1], "from-number");
    memoPut("id@L1", ["1"], "from-string");
    const snap = memoCacheSnapshot().get("id@L1")!;
    expect(snap.size).toBe(2);
    expect(memoLookup("id@L1", [1])).not.toBe(MEMO_MISS);
    expect(memoLookup("id@L1", ["1"])).not.toBe(MEMO_MISS);
  });

  test("impure function stays unwrapped even past threshold", () => {
    // `print(x)` inside the body is a call to an unknown (non-self) identifier,
    // which the syntactic purity checker conservatively rejects.
    const { ast, reactive } = setup("def f(x):\n    print(x)\n    return x");
    reactive.converge();
    const fd = findFunctionDef(ast, "f");

    for (let i = 0; i < MEMOIZATION_THRESHOLD * 2; i++) reactive.observeCall(ast, fd);
    reactive.tick();

    expect(reactive.units.get(fd)!.hints.get(fd)?.[MEMOIZED_FIELD]).toBeFalsy();
    // Body length unchanged — no prelude inserted.
    expect(fd.body.length).toBe(2);
  });
});
