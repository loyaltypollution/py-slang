/**
 * Documents the current state of the SVML JIT's runtime-refinement path.
 * The OSR plumbing (coordinator + swap strategy + patchFunction) is wired
 * end-to-end and mechanically covered by `svml-jit-end-to-end.test.ts`.
 * This file pins down what the loop actually does on a real execution.
 *
 * Finding: `install` does fire (notifications propagate from the worklist
 * and trigger a recompile), but the recompiled IR is **byte-identical**
 * to the original because runtime observations cannot refine any existing
 * hint. Root cause:
 *
 *   - Every RHS expression visited by the DFA is annotated with a hint
 *     (at worst `CONST_TOP`, see const-analysis/analysis.ts `annotate`).
 *   - SVML only records a write site when the RHS hint is non-concrete
 *     (svml-compiler.ts `isHintConcrete` gate), so every runtime
 *     observation lands on a hint that is already TOP.
 *   - `mergeIntoHint` widens via `constJoin` / type `join`
 *     (const-analysis/analysis.ts:264, const-analysis/lattice.ts:37).
 *     `constJoin(CONST_TOP, const(v)) = CONST_TOP` — observation absorbed
 *     without changing the hint.
 *   - Notifications still reach the coordinator because `observeCall`
 *     unconditionally reseeds the callee (persistent-worklist.ts
 *     `rebuildAndReseed`), and freshly-reseeded analysis sessions have
 *     `null` prevOut so the first processed block counts as "changed".
 *     The recompile then walks the same unchanged hints and emits the
 *     same IR.
 *
 * When a future change adds a meet-on-observe path (or a speculation
 * dimension with non-monotonic updates), the IR-equality assertion will
 * flip and this test should be rewritten to assert a specific refinement
 * (see `test.todo` below).
 */

import { StmtNS } from "../ast-types";
import { parse } from "../parser/parser-adapter";
import { analyzeWithEnvironments } from "../resolver";
import {
  OSRCoordinator,
  type StateDeltaStrategy,
  type FunctionUnit,
} from "../specialization";
import { buildTestWorklist } from "./utils";
import { SVMLCompiler } from "../engines/svml/svml-compiler";
import { SVMLInterpreter } from "../engines/svml/svml-interpreter";
import type { SVMLIR } from "../engines/svml/types";
import { SVMLSwapStrategy, type SVMLDelta } from "../conductor/svml-swap-strategy";

function buildUnit(code: string) {
  const script = code + "\n";
  const ast = parse(script) as StmtNS.FileInput;
  const { environments } = analyzeWithEnvironments(ast, script, 4);
  const reactive = buildTestWorklist(ast, environments);
  reactive.converge();
  const compiler = SVMLCompiler.fromProgramUnit(ast, environments, reactive.units);
  const program = compiler.compileProgram(ast);
  return { ast, reactive, compiler, program };
}

/** Wrap a base strategy and record every applyDelta call. */
function makeRecorder(base: StateDeltaStrategy<SVMLDelta>): {
  strategy: StateDeltaStrategy<SVMLDelta>;
  installs: Array<{ key: StmtNS.FileInput | StmtNS.FunctionDef; code: SVMLIR }>;
} {
  const installs: Array<{ key: StmtNS.FileInput | StmtNS.FunctionDef; code: SVMLIR }> = [];
  const strategy: StateDeltaStrategy<SVMLDelta> = {
    canInstall(key) {
      return base.canInstall ? base.canInstall(key) : true;
    },
    computeDelta(unit: FunctionUnit) {
      return base.computeDelta(unit);
    },
    applyDelta(key, delta) {
      if (delta.kind === "whole") installs.push({ key, code: delta.ir });
      base.applyDelta(key, delta);
    },
  };
  return { strategy, installs };
}

describe("SVML JIT runtime refinement (currently inert)", () => {
  test("install fires but recompiled IR is byte-identical (plumbing alive, semantics inert)", async () => {
    // Best-case candidate for refinement today: single call site, single
    // monomorphic argument, simple arithmetic use. Statically `x` is TOP
    // (parameter with no caller-visible value); at runtime x=5.
    const code = `
def g(x):
    y = x
    return y + 1
g(5)
`;
    const { ast, reactive, compiler, program } = buildUnit(code);
    const gDef = ast.statements[0] as StmtNS.FunctionDef;
    const gIndex = compiler.indexOf(gDef)!;
    const irBefore = program.functions[gIndex];

    const interpreter = new SVMLInterpreter(program, { observationSink: reactive });
    const base = new SVMLSwapStrategy(compiler, interpreter);
    const { strategy, installs } = makeRecorder(base);

    const coord = new OSRCoordinator(reactive, strategy);
    const stop = coord.start();
    try {
      await reactive.withActiveScope(ast, () => interpreter.execute());
    } finally {
      stop();
    }

    // No runtime refinement: every observeWrite lands on a TOP hint and is
    // absorbed by the widening merge, so no notification reaches the OSR
    // coordinator.
    // The loop is mechanically alive: observeCall reseeds g, the fresh
    // session produces a "changed" notification, the coordinator
    // recompiles g, and install fires.
    expect(coord.stats.notificationsSeen).toBeGreaterThan(0);
    expect(coord.stats.installsFired).toBeGreaterThan(0);
    expect(installs.some(i => i.key === gDef)).toBe(true);

    // But semantic refinement is inert: every install carries an IR that
    // is byte-identical to the original compile. When the widening issue
    // is fixed, this assertion flips — see file-level comment.
    for (const { key, code } of installs) {
      if (key !== gDef) continue;
      expect(Array.from(code.opcodes)).toEqual(Array.from(irBefore.opcodes));
      expect(Array.from(code.arg1s)).toEqual(Array.from(irBefore.arg1s));
      expect(Array.from(code.arg2s)).toEqual(Array.from(irBefore.arg2s));
      expect(code.strings).toEqual(irBefore.strings);
    }
  });

  test("coordinator stats are zero when no work is pending post-subscribe", () => {
    // buildUnit's converge() drains before the coordinator attaches, so an
    // idle tick should leave all counters at zero. Sanity-checks that the
    // counters aren't accidentally bumped by subscribe/unsubscribe.
    const { ast, reactive, compiler, program } = buildUnit("x = 1 + 2");
    const interpreter = new SVMLInterpreter(program, { observationSink: reactive });
    const strategy = new SVMLSwapStrategy(compiler, interpreter);

    const coord = new OSRCoordinator(reactive, strategy);
    const stop = coord.start();
    try {
      reactive.tick();
    } finally {
      stop();
    }
    void ast;

    expect(coord.stats.notificationsSeen).toBe(0);
    expect(coord.stats.installsFired).toBe(0);
  });

  test.todo(
    "install fires when a runtime observation narrows a hint — requires meet-on-observe path",
  );
});
