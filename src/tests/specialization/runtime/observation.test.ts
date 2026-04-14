import { StmtNS } from "../../../ast-types";
import { parse } from "../../../parser/parser-adapter";
import { analyzeWithEnvironments } from "../../../resolver";
import { Context } from "../../../engines/cse/context";
import { evaluate } from "../../../engines/cse/interpreter";
import { SVMLCompiler } from "../../../engines/svml/svml-compiler";
import { SVMLInterpreter } from "../../../engines/svml/svml-interpreter";
import {
  observeRuntimeWrite,
  runtimeCallPass,
} from "../../../specialization/framework/runtime-passes";
import { STR_BIT } from "../../../specialization/type-analysis/lattice";
import { readExprFact } from "../../../specialization/framework/dfa-factory";
import { typeAnalysisPass } from "../../../specialization/framework/dfa-passes";
import { makeDfaQuery } from "../../../specialization";
import { buildTestWorklist } from "../../utils";

function build(code: string) {
  const script = code + "\n";
  const ast = parse(script) as StmtNS.FileInput;
  const { environments } = analyzeWithEnvironments(ast, script, 4);
  const reactive = buildTestWorklist(ast, environments);
  return { ast, environments, reactive };
}

// Runtime string assignment must reach the fact store through the observe sink
// in both engines. Parameterized so each engine's wire-up is a single row.
describe.each([
  {
    engine: "CSE",
    async observe(code: string) {
      const { ast, reactive } = build(code);
      reactive.drain();
      const context = new Context();
      context.runtime.observeNodeWrite = (nodeId, value) =>
        observeRuntimeWrite(reactive, nodeId, value);
      context.runtime.rootScope = ast;
      await evaluate("", ast, context, { variant: 4, groups: [] });
      reactive.drain();
      return { ast, reactive };
    },
  },
  {
    engine: "SVML",
    async observe(code: string) {
      const { ast, environments, reactive } = build(code);
      reactive.drain();
      const compiler = SVMLCompiler.fromProgramUnit(
        ast,
        environments,
        makeDfaQuery(reactive.factStore, reactive.nodeIndex),
      );
      const interpreter = new SVMLInterpreter(compiler.compileProgram(ast), {
        observeNodeWrite: (nodeId, value) => observeRuntimeWrite(reactive, nodeId, value),
      });
      await interpreter.execute();
      reactive.drain();
      return { ast, reactive };
    },
  },
])("$engine observation sink", ({ observe }) => {
  test("string store widens RHS fact to include STR_BIT", async () => {
    const { ast, reactive } = await observe(`
x = 1
x = "hello"
`);
    const secondAssign = ast.statements[1] as StmtNS.Assign;
    const type = readExprFact(
      reactive.factStore,
      typeAnalysisPass,
      reactive.blockOfNode(secondAssign.value.id),
      secondAssign.value.id,
    );
    expect(type).toBeDefined();
    expect(type!.kinds & STR_BIT).toBeTruthy();
  });
});

// Idempotence: observing a value the static analysis already knows about
// must not perturb the fact store. This is the guard rail that lets the
// worklist quiesce after runtime input converges.
describe("observation: idempotence", () => {
  test("re-observing a known value leaves the fact equal", () => {
    const { ast, reactive } = build("x = 42");
    reactive.drain();
    const assign = ast.statements[0] as StmtNS.Assign;
    const block = reactive.blockOfNode(assign.value.id);
    const before = readExprFact(reactive.factStore, typeAnalysisPass, block, assign.value.id);
    observeRuntimeWrite(reactive, assign.value.id, 42);
    const after = readExprFact(reactive.factStore, typeAnalysisPass, block, assign.value.id);
    expect(after).toEqual(before);
  });
});

// Call observation: user-function calls surface to the call-count pass, which
// is how the memoization transform gets its threshold signal.
describe("SVML observeScopeCall", () => {
  test("fires with the callee FunctionDef's scope id on each user call", async () => {
    const { ast, environments, reactive } = build(`
def f():
    return 1
f()
`);
    reactive.drain();
    const fDef = ast.statements[0] as StmtNS.FunctionDef;
    const calls: number[] = [];
    const callCounts = new Map<number, number>();

    const compiler = SVMLCompiler.fromProgramUnit(
      ast,
      environments,
      makeDfaQuery(reactive.factStore, reactive.nodeIndex),
    );
    const interpreter = new SVMLInterpreter(compiler.compileProgram(ast), {
      observeScopeCall: scopeId => {
        calls.push(scopeId);
        const next = (callCounts.get(scopeId) ?? 0) + 1;
        callCounts.set(scopeId, next);
        reactive.observe(runtimeCallPass, scopeId, next);
      },
    });

    await interpreter.execute();
    reactive.drain();
    expect(calls).toContain(fDef.id);
  });
});
