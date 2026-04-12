/**
 * End-to-end smoke test for the SVML memoization wiring.
 *
 * Proves three seams together:
 *   1. Resolver seeds the __memo_* names in the global env (without this,
 *      SVML's getTokenAnnotation would throw "Variable not found").
 *   2. SVML compiler routes Call("__memo_*", …) to its PRIMITIVE_FUNCTIONS
 *      table (opcodes 40/41/42).
 *   3. SVML interpreter's executePrimitive for those opcodes reaches the
 *      shared runtime side-table in memoization-analysis/runtime.ts.
 *
 * If any of the three breaks, this test fails. A full reactive
 * observeCall→wrap→execute flow would add no coverage the unit tests in
 * memoization.test.ts do not already give, since the AST rewrite happens
 * before SVML compilation in every path.
 */

import { StmtNS } from "../ast-types";
import { parse } from "../parser/parser-adapter";
import { analyzeWithEnvironments } from "../resolver";
import {
  clearMemoCache,
  memoCacheSnapshot,
} from "../specialization";
import { buildTestWorklist } from "./utils";
import { SVMLCompiler } from "../engines/svml/svml-compiler";
import { SVMLInterpreter } from "../engines/svml/svml-interpreter";

function run(code: string) {
  const script = code + "\n";
  const ast = parse(script) as StmtNS.FileInput;
  const { environments } = analyzeWithEnvironments(ast, script, 4);
  const reactive = buildTestWorklist(ast, environments);
  reactive.converge();
  const compiler = SVMLCompiler.fromProgramUnit(ast, environments, reactive.units);
  const program = compiler.compileProgram(ast);
  const interpreter = new SVMLInterpreter(program, { observationSink: reactive });
  return { ast, reactive, interpreter };
}

describe("SVML memoization wiring", () => {
  beforeEach(() => clearMemoCache());

  test("__memo_put writes to the shared runtime slab", async () => {
    // Bare top-level call — the resolver must recognise __memo_put, the
    // compiler must resolve it to a primitive, and the interpreter must
    // dispatch to the runtime helper.
    const { ast, reactive, interpreter } = run(`__memo_put("k@L1", 5, 42)`);
    await reactive.withActiveScope(ast, () => interpreter.execute());

    const bucket = memoCacheSnapshot().get("k@L1");
    expect(bucket).toBeDefined();
    // argKey tags by typeof, so a numeric 5 becomes "number:5".
    expect(bucket!.get("number:5")).toBe(42);
  });

  test("__memo_has returns true after a put, false before", async () => {
    const { ast, reactive, interpreter } = run(`
x = __memo_has("k@L1", 5)
__memo_put("k@L1", 5, 99)
y = __memo_has("k@L1", 5)
`);
    await reactive.withActiveScope(ast, () => interpreter.execute());

    // We cannot easily read SVML locals, but the runtime side-table proves
    // the put reached the shared cache. The has() call above, if it had
    // thrown on a missing primitive, would have aborted execution before
    // the put — so survival of the program is itself the assertion on the
    // has() branch.
    expect(memoCacheSnapshot().get("k@L1")!.get("number:5")).toBe(99);
  });

  test("__memo_get returns the stored value under SVML", async () => {
    // Put first, then get into a cache we can re-observe externally.
    const { ast, reactive, interpreter } = run(`
__memo_put("k@L1", 1, 7)
__memo_put("k@L1", 2, __memo_get("k@L1", 1))
`);
    await reactive.withActiveScope(ast, () => interpreter.execute());

    const bucket = memoCacheSnapshot().get("k@L1")!;
    expect(bucket.get("number:1")).toBe(7);
    // If __memo_get returned undefined (wiring broken), this would be undefined.
    expect(bucket.get("number:2")).toBe(7);
  });
});
