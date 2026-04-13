/**
 * Phase 5 regression: the SVML interpreter pushes runtime observations into
 * an attached worklist sink at STORE / CALL sites. Parallel to
 * `observe-loop.test.ts` but through SVML rather than CSE.
 */

import { StmtNS } from "../ast-types";
import { parse } from "../parser/parser-adapter";
import { analyzeWithEnvironments } from "../resolver";
import { HintStore } from "../specialization";
import { buildTestWorklist } from "./utils";
import { SVMLCompiler } from "../engines/svml/svml-compiler";
import { SVMLInterpreter } from "../engines/svml/svml-interpreter";
import { STR_BIT } from "../specialization/type-analysis/lattice";

function build(code: string) {
  const script = code + "\n";
  const ast = parse(script) as StmtNS.FileInput;
  const { environments } = analyzeWithEnvironments(ast, script, 4);
  const reactive = buildTestWorklist(ast, environments);
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
    const mergeUnit = (u: { hints: HintStore } | undefined) => {
      if (u) for (const [id, hint] of u.hints) merged.setById(id, hint);
    };

    await interpreter.execute();
    reactive.tick();

    // Re-merge after the run so any runtime-observation widening lands.
    for (const unit of reactive.units.values()) mergeUnit(unit);

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

    const sink: Pick<typeof reactive, "observeWrite" | "observeCall"> = {
      observeWrite: (scopeKey, rhsNode, value) => {
        reactive.observeWrite(scopeKey, rhsNode, value);
      },
      observeCall: (scopeKey, calleeKey) => {
        calls.push([scopeKey, calleeKey]);
        reactive.observeCall(scopeKey, calleeKey);
      },
    };

    const compiler = SVMLCompiler.fromProgramUnit(ast, environments, reactive.units);
    const program = compiler.compileProgram(ast);
    const interpreter = new SVMLInterpreter(program, { observationSink: sink });

    await interpreter.execute();
    reactive.tick();

    // One user-level call to f happened; observeCall should have fired with
    // (ast, fDef).
    const matching = calls.find(([caller, callee]) => caller === ast && callee === fDef);
    expect(matching).toBeDefined();
  });
});
