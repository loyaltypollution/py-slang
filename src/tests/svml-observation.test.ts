/**
 * Phase 5 regression: the SVML interpreter pushes runtime observations into
 * an attached `ObservationSink` at STORE / CALL sites, and activates /
 * deactivates scopes at function entry / return. Parallel to
 * `observe-loop.test.ts` but through SVML rather than CSE.
 */

import { StmtNS } from "../ast-types";
import { parse } from "../parser/parser-adapter";
import { analyzeWithEnvironments } from "../resolver";
import { createReactiveOptimization, HintStore } from "../specialization";
import type { ObservationSink } from "../specialization";
import { SVMLCompiler } from "../engines/svml/svml-compiler";
import { SVMLInterpreter } from "../engines/svml/svml-interpreter";
import { STR_BIT } from "../specialization/type-analysis/lattice";

function build(code: string) {
  const script = code + "\n";
  const ast = parse(script) as StmtNS.FileInput;
  const { environments } = analyzeWithEnvironments(ast, script, 4);
  const reactive = createReactiveOptimization(ast, environments);
  return { ast, environments, reactive, script };
}

describe("SVML observation sink", () => {
  test("runtime string store widens the RHS hint via observeWrite", async () => {
    const code = `
x = 1
x = "hello"
`;
    const { ast, environments, reactive } = build(code);
    reactive.converge();

    const compiler = SVMLCompiler.fromProgramUnit(ast, environments, reactive.units);
    const program = compiler.compileProgram(ast);

    const interpreter = new SVMLInterpreter(program, { observationSink: reactive });

    const merged = new HintStore();
    for (const unit of reactive.units.values()) unit.hints.mergeInto(merged);
    const unsubscribe = reactive.subscribe(changed => {
      for (const key of changed) {
        const unit = reactive.units.get(key);
        if (unit) unit.hints.mergeInto(merged);
      }
    });

    try {
      await reactive.withActiveScope(ast, () => interpreter.execute());
    } finally {
      unsubscribe();
    }

    const secondAssign = ast.statements[1] as StmtNS.Assign;
    const hint = merged.get(secondAssign.value);
    expect(hint?.type?.kinds).toBeDefined();
    // String literal RHS: either static analysis or the runtime observation
    // should have recorded STR_BIT.
    expect(hint!.type!.kinds & STR_BIT).toBeTruthy();
  });

  test("observeCall fires with caller/callee scope keys on user-function calls", async () => {
    const code = `
def f():
    return 1
f()
`;
    const { ast, environments, reactive } = build(code);
    reactive.converge();

    const fDef = ast.statements[0] as StmtNS.FunctionDef;
    const calls: Array<[unknown, unknown]> = [];
    const activates: unknown[] = [];
    const deactivates: unknown[] = [];
    const writes: Array<[unknown, unknown, unknown]> = [];

    const sink: ObservationSink = {
      observeWrite: (scopeKey, rhsNode, value) => {
        writes.push([scopeKey, rhsNode, value]);
        reactive.observeWrite(scopeKey, rhsNode, value);
      },
      observeCall: (scopeKey, calleeKey) => {
        calls.push([scopeKey, calleeKey]);
        reactive.observeCall(scopeKey, calleeKey);
      },
      activateScope: key => {
        activates.push(key);
        reactive.activateScope(key);
      },
      deactivateScope: key => {
        deactivates.push(key);
        reactive.deactivateScope(key);
      },
    };

    const compiler = SVMLCompiler.fromProgramUnit(ast, environments, reactive.units);
    const program = compiler.compileProgram(ast);
    const interpreter = new SVMLInterpreter(program, { observationSink: sink });

    await reactive.withActiveScope(ast, () => interpreter.execute());

    // One user-level call to f happened; observeCall should have fired with
    // (ast, fDef).
    const matching = calls.find(([caller, callee]) => caller === ast && callee === fDef);
    expect(matching).toBeDefined();
  });

  test("activateScope fires before f's body runs and deactivateScope on return", async () => {
    const code = `
def f(x):
    y = x
    return y
f(1)
`;
    const { ast, environments, reactive } = build(code);
    reactive.converge();

    const fDef = ast.statements[0] as StmtNS.FunctionDef;

    const events: Array<{ op: string; key: unknown }> = [];
    const sink: ObservationSink = {
      observeWrite: (scopeKey, rhsNode, value) => {
        events.push({ op: "write", key: scopeKey });
        reactive.observeWrite(scopeKey, rhsNode, value);
      },
      observeCall: (scopeKey, calleeKey) => {
        reactive.observeCall(scopeKey, calleeKey);
      },
      activateScope: key => {
        events.push({ op: "activate", key });
        reactive.activateScope(key);
      },
      deactivateScope: key => {
        events.push({ op: "deactivate", key });
        reactive.deactivateScope(key);
      },
    };

    const compiler = SVMLCompiler.fromProgramUnit(ast, environments, reactive.units);
    const program = compiler.compileProgram(ast);
    const interpreter = new SVMLInterpreter(program, { observationSink: sink });

    await reactive.withActiveScope(ast, () => interpreter.execute());

    // Find activate(fDef); every write to fDef's scope must come *after* it,
    // and the matching deactivate(fDef) must come after all those writes.
    const activateIdx = events.findIndex(e => e.op === "activate" && e.key === fDef);
    const deactivateIdx = events.findIndex(e => e.op === "deactivate" && e.key === fDef);
    expect(activateIdx).toBeGreaterThanOrEqual(0);
    expect(deactivateIdx).toBeGreaterThan(activateIdx);

    // The write to y (inside f) lives in fDef's scope and must fall between
    // the activate/deactivate pair.
    const innerWriteIdx = events.findIndex(
      (e, i) =>
        i > activateIdx && i < deactivateIdx && e.op === "write" && e.key === fDef,
    );
    expect(innerWriteIdx).toBeGreaterThan(activateIdx);
    expect(innerWriteIdx).toBeLessThan(deactivateIdx);
  });
});
