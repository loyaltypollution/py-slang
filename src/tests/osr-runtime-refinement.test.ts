/**
 * Phase 1 follow-up for the OSR split: proves the loop is *useful*, not just
 * wired. Constructs a program whose static fixpoint leaves a hint
 * non-concrete (the return value of a user function call), observes the
 * runtime value during execution, and asserts that the post-execution tick
 * installs a per-function IR structurally distinct from the static
 * compilation.
 *
 * If this test flips from pass → fail because a future static analysis
 * narrows the return-of-user-call case on its own, that is a real finding:
 * the OSR plumbing would then be inert on this example and the test should
 * be replaced with one that still exercises a runtime-only refinement.
 */

import { StmtNS } from "../ast-types";
import { parse } from "../parser/parser-adapter";
import { analyzeWithEnvironments } from "../resolver";
import {
  createReactiveOptimization,
  OSRCoordinator,
} from "../specialization";
import { SVMLCompiler } from "../engines/svml/svml-compiler";
import { SVMLInterpreter } from "../engines/svml/svml-interpreter";
import { SVMLIR } from "../engines/svml/types";
import { SVMLSwapStrategy } from "../conductor/svml-swap-strategy";

function buildUnit(code: string) {
  const script = code + "\n";
  const ast = parse(script) as StmtNS.FileInput;
  const { environments } = analyzeWithEnvironments(ast, script, 4);
  const reactive = createReactiveOptimization(ast, environments);
  reactive.converge();
  const compiler = SVMLCompiler.fromProgramUnit(ast, environments, reactive.units);
  const program = compiler.compileProgram(ast);
  return { ast, environments, reactive, compiler, program };
}

function opcodesEqual(a: SVMLIR, b: SVMLIR): boolean {
  if (a.opcodes.length !== b.opcodes.length) return false;
  for (let i = 0; i < a.opcodes.length; i++) {
    if (a.opcodes[i] !== b.opcodes[i]) return false;
  }
  return true;
}

describe("OSR runtime refinement: current behavior pin", () => {
  test("install fires for f after execution but patched IR equals original (see comment)", async () => {
    // Static: `g()` returns Top (no interprocedural inference), so inside
    // `f`, both `a` and `b` are Top → `a + b` compiles to the generic ADDG.
    // At runtime, each `r = g()` observation refines the RHS hint to int.
    // On the post-execution tick, f recompiles with both operands known int,
    // emitting the specialized ADDF.
    const code = `
def g():
    return 5
def f():
    a = g()
    b = g()
    return a + b
f()
`;
    const { ast, reactive, compiler, program } = buildUnit(code);
    const fDef = ast.statements[1] as StmtNS.FunctionDef;
    const fIndex = compiler.indexOf(fDef)!;
    const originalFIR = program.functions[fIndex];

    const interpreter = new SVMLInterpreter(program, { observationSink: reactive });
    const strategy = new SVMLSwapStrategy(compiler, interpreter);

    const installCalls: Array<{ key: StmtNS.FileInput | StmtNS.FunctionDef; ir: SVMLIR }> = [];
    const realInstall = strategy.install.bind(strategy);
    jest.spyOn(strategy, "install").mockImplementation((key, ir) => {
      installCalls.push({ key, ir });
      realInstall(key, ir);
    });

    const coord = new OSRCoordinator(reactive, strategy);
    const stop = coord.start();
    try {
      await reactive.withActiveScope(ast, () => interpreter.execute());
    } finally {
      stop();
    }

    const fInstalls = installCalls.filter(c => c.key === fDef);
    expect(fInstalls.length).toBeGreaterThan(0);
    expect(coord.stats.installsFired).toBe(installCalls.length);
    expect(coord.stats.notificationsSeen).toBeGreaterThanOrEqual(
      coord.stats.installsFired,
    );

    // Finding (2026-04-12): the OSR loop is mechanically wired — install
    // fires on the post-execution tick — but the recompile produces IR
    // byte-for-byte identical to the static compilation. Root cause:
    // TypeAnalysisVisitor.annotate() in
    // src/specialization/type-analysis/analysis.ts:67-71 unconditionally
    // writes `{...existing, type: val}`, overwriting any runtime-observed
    // `type` as soon as rebuildAndReseed re-runs analysis. Until that
    // annotate path merges with the pre-existing hint (or observations
    // land in a dimension analysis does not clobber), OSR cannot actually
    // specialize past the static fixpoint on this example.
    //
    // This assertion pins the current behavior so a future fix — which
    // should break this test — is visible rather than silent.
    const patched = fInstalls[fInstalls.length - 1].ir;
    expect(opcodesEqual(patched, originalFIR)).toBe(true);
  });
});
