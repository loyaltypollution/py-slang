import { StmtNS } from "../../../ast-types";
import { parse } from "../../../parser/parser-adapter";
import { analyzeWithEnvironments } from "../../../resolver";
import { Context } from "../../../engines/cse/context";
import { evaluate } from "../../../engines/cse/interpreter";
import { SVMLCompiler } from "../../../engines/svml/svml-compiler";
import { SVMLInterpreter } from "../../../engines/svml/svml-interpreter";
import {
  observeRuntimeReturn,
  observeRuntimeWrite,
  runtimeCallAnalysis,
  runtimeReturnAnalysis,
} from "../../../specialization/framework/runtime-analyses";
import { INT_BIT, STR_BIT } from "../../../specialization/type-analysis/lattice";
import { ROOT_CONTEXT } from "../../../specialization/framework/context";
import { readExprFact } from "../../../specialization/framework/dfa-factory";
import { typeAnalysis } from "../../../specialization/framework/dfa-analyses";
import { makeDfaQuery } from "../../../specialization";
import { buildTestWorklist } from "../../utils";

function build(code: string) {
  const script = code + "\n";
  const ast = parse(script);
  const { environments } = analyzeWithEnvironments(ast, script, 4);
  const reactive = buildTestWorklist(ast, environments);
  return { ast, environments, reactive };
}

// Runtime string assignment must reach runtimeWriteAnalysis through the
// observe sink in both engines. Parameterized so each engine's wire-up is
// a single row.
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
        makeDfaQuery(reactive.topology),
        reactive.registry,
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
  test("string store keeps ROOT fact baseline-only and narrows only under spec context", async () => {
    const code = `
def f(x):
    y = x
    return y
f("hello")
`;
    const baseline = build(code);
    baseline.reactive.drain();
    const baselineFn = baseline.ast.statements[0] as StmtNS.FunctionDef;
    const baselineRead = (baselineFn.body[0] as StmtNS.Assign).value;
    const baselineType = readExprFact(
      baseline.reactive.topology,
      typeAnalysis,
      baselineRead.id,
      ROOT_CONTEXT,
    );

    const { ast, reactive } = await observe(code);
    const fn = ast.statements[0] as StmtNS.FunctionDef;
    const xRead = (fn.body[0] as StmtNS.Assign).value;
    const rootType = readExprFact(
      reactive.topology,
      typeAnalysis,
      xRead.id,
      ROOT_CONTEXT,
    );
    const specCtx = reactive.specContextForNode(xRead.id);
    const specType = readExprFact(
      reactive.topology,
      typeAnalysis,
      xRead.id,
      specCtx,
    );
    expect(rootType).toEqual(baselineType);
    expect(specCtx).not.toBe(ROOT_CONTEXT);
    expect(specType).toBeDefined();
    expect(specType!.kinds & STR_BIT).toBeTruthy();
  });
});

// Idempotence: re-observing a value the static analysis already knows about
// must not perturb ROOT facts. The observation may still allocate a
// speculative context, but baseline facts remain unchanged.
describe("observation: idempotence", () => {
  test("re-observing a known value leaves the ROOT fact equal", () => {
    const { ast, reactive } = build("x = 42");
    reactive.drain();
    const assign = ast.statements[0] as StmtNS.Assign;
    const before = readExprFact(
      reactive.topology,
      typeAnalysis, assign.value.id, ROOT_CONTEXT);
    observeRuntimeWrite(reactive, assign.value.id, 42);
    const after = readExprFact(
      reactive.topology,
      typeAnalysis, assign.value.id, ROOT_CONTEXT);
    const specCtx = reactive.specContextForNode(assign.value.id);
    const spec = readExprFact(
      reactive.topology,
      typeAnalysis, assign.value.id, specCtx);
    expect(after).toEqual(before);
    expect(spec).toEqual(before);
  });
});

// Call observation: user-function calls surface to the call-count analysis, which
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
      makeDfaQuery(reactive.topology),
      reactive.registry,
    );
    const interpreter = new SVMLInterpreter(compiler.compileProgram(ast), {
      observeScopeCall: scopeId => {
        calls.push(scopeId);
        const next = (callCounts.get(scopeId) ?? 0) + 1;
        callCounts.set(scopeId, next);
        reactive.observe(runtimeCallAnalysis, scopeId, next);
      },
    });

    await interpreter.execute();
    reactive.drain();
    expect(calls).toContain(fDef.id);
  });
});

describe("SVML observeScopeReturn", () => {
  test("fires with the returning FunctionDef's scope id and seeds entry requirements", async () => {
    const { ast, environments, reactive } = build(`
def f(x):
    return x + 1
f(41)
`);
    reactive.drain();
    const fDef = ast.statements[0] as StmtNS.FunctionDef;
    const returns: Array<{ scopeId: number; value: unknown }> = [];

    const compiler = SVMLCompiler.fromProgramUnit(
      ast,
      environments,
      makeDfaQuery(reactive.topology),
      reactive.registry,
    );
    const interpreter = new SVMLInterpreter(compiler.compileProgram(ast), {
      observeScopeReturn: (scopeId, value) => {
        returns.push({ scopeId, value });
        observeRuntimeReturn(reactive, scopeId, value);
      },
    });

    await interpreter.execute();
    reactive.drain();

    expect(returns).toContainEqual({ scopeId: fDef.id, value: 42 });
    const observed = reactive.tryRead(runtimeReturnAnalysis, fDef.id, ROOT_CONTEXT);
    expect(observed).toBeDefined();
    expect(observed!.kind).toBe("number");

    const reqs = makeDfaQuery(
      reactive.topology,
      nodeId => reactive.specContextForNode(nodeId),
      unit => reactive.specContextFor(unit),
    ).entryRequirementsOf(fDef.id);
    expect(reqs).toBeDefined();
    expect(reqs!.provable.get(0)?.kinds).toBe(INT_BIT);
  });
});
