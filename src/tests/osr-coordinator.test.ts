/**
 * Tests for OSRCoordinator wiring against PersistentWorklist.
 *
 * Asserts:
 *   (a) install fires for changed scopes after a transform completes;
 *   (b) install is skipped while a scope is pinned active, then fires on
 *       the next tick after deactivate;
 *   (c) install fires independently per scope in a multi-scope program.
 */

import { StmtNS } from "../ast-types";
import { parse } from "../parser/parser-adapter";
import { analyzeWithEnvironments } from "../resolver";
import {
  createReactiveOptimization,
  OSRCoordinator,
  type CodeSwapStrategy,
  type FunctionUnit,
} from "../specialization";

interface Call {
  key: StmtNS.FileInput | StmtNS.FunctionDef;
  unit: FunctionUnit;
}

function makeRecordingStrategy(): {
  strategy: CodeSwapStrategy<number>;
  recompiles: Call[];
  installs: Array<{ key: StmtNS.FileInput | StmtNS.FunctionDef; code: number }>;
} {
  const recompiles: Call[] = [];
  const installs: Array<{ key: StmtNS.FileInput | StmtNS.FunctionDef; code: number }> = [];
  let n = 0;
  const strategy: CodeSwapStrategy<number> = {
    recompile(unit) {
      recompiles.push({ key: unit.funcAst, unit });
      return ++n;
    },
    install(key, code) {
      installs.push({ key, code });
    },
  };
  return { strategy, recompiles, installs };
}

function setup(code: string) {
  const script = code + "\n";
  const ast = parse(script) as StmtNS.FileInput;
  const { environments } = analyzeWithEnvironments(ast, script, 4);
  const reactive = createReactiveOptimization(ast, environments);
  return { ast, reactive };
}

describe("OSRCoordinator", () => {
  test("install fires on transform completion for the root scope", () => {
    const { ast, reactive } = setup("x = 1 + 2");
    const { strategy, installs } = makeRecordingStrategy();
    const coord = new OSRCoordinator(reactive, strategy);
    const stop = coord.start();
    try {
      reactive.converge();
    } finally {
      stop();
    }

    expect(installs.length).toBeGreaterThan(0);
    expect(installs.some(i => i.key === ast)).toBe(true);
  });

  test("install is skipped while scope is pinned, fires on tick after deactivate", () => {
    const { ast, reactive } = setup("x = 1 + 2");
    const { strategy, installs } = makeRecordingStrategy();
    const coord = new OSRCoordinator(reactive, strategy);
    const stop = coord.start();
    try {
      reactive.activateScope(ast);
      reactive.converge();

      // While pinned, the transform is parked — no notification for `ast`.
      expect(installs.some(i => i.key === ast)).toBe(false);

      reactive.deactivateScope(ast);
      reactive.tick();

      expect(installs.some(i => i.key === ast)).toBe(true);
    } finally {
      stop();
    }
  });

  test("install fires for a function scope independently", () => {
    const code = `
def f():
    x = 1 + 2
def g():
    y = 3 + 4
`;
    const { ast, reactive } = setup(code);
    const fDef = ast.statements[0] as StmtNS.FunctionDef;
    const gDef = ast.statements[1] as StmtNS.FunctionDef;

    const { strategy, installs } = makeRecordingStrategy();
    const coord = new OSRCoordinator(reactive, strategy);
    const stop = coord.start();
    try {
      // Pin f — g should still be optimized and installed independently.
      reactive.activateScope(fDef);
      reactive.converge();

      expect(installs.some(i => i.key === gDef)).toBe(true);
      expect(installs.some(i => i.key === fDef)).toBe(false);

      reactive.deactivateScope(fDef);
      reactive.tick();

      expect(installs.some(i => i.key === fDef)).toBe(true);
    } finally {
      stop();
    }
  });
});
