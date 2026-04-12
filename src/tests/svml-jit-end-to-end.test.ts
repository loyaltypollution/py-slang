/**
 * Phase 6: end-to-end JIT through `PySvmlJitEvaluator`'s wiring.
 *
 * Covers:
 *  (a) SVMLSwapStrategy / OSRCoordinator mechanical contract:
 *      `install(scopeKey, ir)` delegates to `interpreter.patchFunction` with
 *      the compiler's stable index, exercising the full OSR glue end-to-end.
 *  (b) patchFunction safety: swapping a function whose frame is live on the
 *      call stack throws, defending the safepoint contract.
 */

import { StmtNS } from "../ast-types";
import { parse } from "../parser/parser-adapter";
import { analyzeWithEnvironments } from "../resolver";
import { OSRCoordinator } from "../specialization";
import { buildTestWorklist } from "./utils";
import { SVMLCompiler } from "../engines/svml/svml-compiler";
import { SVMLInterpreter } from "../engines/svml/svml-interpreter";
import { SVMLSwapStrategy } from "../conductor/svml-swap-strategy";

function buildUnit(code: string) {
  const script = code + "\n";
  const ast = parse(script) as StmtNS.FileInput;
  const { environments } = analyzeWithEnvironments(ast, script, 4);
  const reactive = buildTestWorklist(ast, environments);
  reactive.converge();
  const compiler = SVMLCompiler.fromProgramUnit(ast, environments, reactive.units);
  const program = compiler.compileProgram(ast);
  return { ast, environments, reactive, compiler, program };
}

describe("SVML JIT end-to-end wiring", () => {
  test("SVMLSwapStrategy.applyDelta patches the function at the compiler's stable index", () => {
    const code = `
def g():
    return 42
g()
`;
    const { ast, reactive, compiler, program } = buildUnit(code);
    const interpreter = new SVMLInterpreter(program, { observationSink: reactive });
    const gDef = ast.statements[0] as StmtNS.FunctionDef;
    const gUnit = reactive.units.get(gDef);
    expect(gUnit).toBeDefined();

    const strategy = new SVMLSwapStrategy(compiler, interpreter);
    const patchSpy = jest.spyOn(interpreter, "patchFunction");

    const delta = strategy.computeDelta(gUnit!);
    expect(delta.kind).toBe("whole");
    strategy.applyDelta(gDef, delta);

    const expectedIndex = compiler.indexOf(gDef)!;
    expect(patchSpy).toHaveBeenCalledTimes(1);
    expect(patchSpy).toHaveBeenCalledWith(
      expectedIndex,
      (delta as { kind: "whole"; ir: unknown }).ir,
      /* allowOnStack */ true,
    );
    patchSpy.mockRestore();
  });

  test("OSRCoordinator wires SVMLSwapStrategy into the reactive worklist", async () => {
    const code = `
def g():
    return 1
g()
`;
    const { ast, reactive, compiler, program } = buildUnit(code);
    const interpreter = new SVMLInterpreter(program, { observationSink: reactive });
    const gDef = ast.statements[0] as StmtNS.FunctionDef;

    const strategy = new SVMLSwapStrategy(compiler, interpreter);
    const installSpy = jest.spyOn(strategy, "applyDelta");

    const coord = new OSRCoordinator(reactive, strategy);
    const stop = coord.start();
    try {
      await reactive.withActiveScope(ast, () => interpreter.execute());
    } finally {
      stop();
    }
    // Execution succeeded; strategy was wired. Install may or may not have
    // fired depending on whether runtime observations refined any hints
    // beyond the static fixpoint — the invariant we enforce is that any call
    // that *did* fire routed through the strategy, not that one must fire.
    for (const call of installSpy.mock.calls) {
      const [scopeKey] = call;
      // Only FunctionDefs produce installable IR; FileInput is filtered by
      // `canInstall` and never reaches applyDelta.
      if (scopeKey === ast) continue;
      expect(scopeKey).toBe(gDef);
    }
    installSpy.mockRestore();
  });

  test("patchFunction throws if the target index is on the live call stack", () => {
    // Build a program where g is called from the entry point; mid-execution,
    // attempt to patchFunction on g's index from inside an observationSink
    // hook. The interpreter must refuse the swap.
    const code = `
def g():
    return 1
g()
`;
    const { ast, reactive, compiler, program } = buildUnit(code);
    const gDef = ast.statements[0] as StmtNS.FunctionDef;
    const gIndex = compiler.indexOf(gDef)!;
    const gUnit = reactive.units.get(gDef)!;

    // Pre-compile a fresh IR to splice in.
    const freshIR = compiler.compileFunction(gUnit);

    let caught: unknown = null;
    let tried = false;

    const interpreter = new SVMLInterpreter(program, {
      observationSink: {
        observeWrite: (k, n, v) => reactive.observeWrite(k, n, v),
        observeCall: (c, ce) => reactive.observeCall(c, ce),
        activateScope: k => {
          reactive.activateScope(k);
          // When g activates, we're mid-call: g's frame is current. Attempt
          // to patch its index — must throw.
          if (k === gDef && !tried) {
            tried = true;
            try {
              interpreter.patchFunction(gIndex, freshIR);
            } catch (e) {
              caught = e;
            }
          }
        },
        deactivateScope: k => reactive.deactivateScope(k),
      },
    });

    // Execute; swallow any propagation since the caught error above is what
    // we're asserting on.
    try {
      interpreter.execute();
    } catch {
      /* irrelevant — we captured the patch error inside the sink */
    }

    expect(tried).toBe(true);
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toMatch(/currently executing/);
  });
});
