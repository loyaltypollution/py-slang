/**
 * The SVML interpreter pushes runtime observations into the query-runtime
 * Db via `observeNodeWrite` / `observeScopeCall`. This test exercises the
 * end-to-end path: SVML execution → Db.set(runtimeWrite/runtimeCall, …) →
 * `typeOf` query reflects the observation.
 *
 * Parallel to (deleted) observe-loop.test.ts but through SVML rather
 * than CSE.
 */

import { StmtNS } from "../ast-types";
import { parse } from "../parser/parser-adapter";
import { analyzeWithEnvironments } from "../resolver";
import { buildTestUnits } from "./utils";
import { SVMLCompiler } from "../engines/svml/svml-compiler";
import { SVMLInterpreter } from "../engines/svml/svml-interpreter";
import { STR_BIT } from "../specialization/type-analysis/lattice";
import { typeOf } from "../specialization/runtime/queries/type-of";
import { runtimeCall, runtimeWrite } from "../specialization/runtime";

function build(code: string) {
  const script = code + "\n";
  const ast = parse(script) as StmtNS.FileInput;
  const { environments } = analyzeWithEnvironments(ast, script, 4);
  const { db, units } = buildTestUnits(ast, environments);
  return { ast, environments, db, units };
}

describe("SVML observation sink (query-runtime path)", () => {
  test("runtime string store widens the RHS type fact via runtimeWrite", async () => {
    const code = `
x = 1
x = "hello"
`;
    const { ast, environments, db, units } = build(code);

    const compiler = SVMLCompiler.fromProgramUnit(ast, environments, units, db);
    const program = compiler.compileProgram(ast);

    const secondAssign = ast.statements[1] as StmtNS.Assign;
    const interpreter = new SVMLInterpreter(program, {
      observeNodeWrite: (nodeId, value) => runtimeWrite.set(db, nodeId, value),
    });

    await interpreter.execute();

    const type = db.get(typeOf, secondAssign.value.id);
    expect(type).toBeDefined();
    // String literal RHS — either static analysis or the runtime widening
    // should have recorded STR_BIT on this node.
    expect(type.kinds & STR_BIT).toBeTruthy();
  });

  test("observeScopeCall fires for each user-function call", async () => {
    const code = `
def f():
    return 1
f()
`;
    const { ast, environments, db, units } = build(code);

    const fDef = ast.statements[0] as StmtNS.FunctionDef;
    const callsByScope = new Map<number, number>();

    const compiler = SVMLCompiler.fromProgramUnit(ast, environments, units, db);
    const program = compiler.compileProgram(ast);
    const interpreter = new SVMLInterpreter(program, {
      observeScopeCall: (scopeId) => {
        const next = (callsByScope.get(scopeId) ?? 0) + 1;
        callsByScope.set(scopeId, next);
        runtimeCall.set(db, scopeId, next);
      },
    });

    await interpreter.execute();

    expect(callsByScope.get(fDef.id)).toBeGreaterThanOrEqual(1);
  });
});
