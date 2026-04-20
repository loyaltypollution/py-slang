import { StmtNS } from "../../../ast-types";
import { parse } from "../../../parser/parser-adapter";
import { analyzeWithEnvironments } from "../../../resolver";
import { Context, type JitHooks } from "../../../engines/cse/context";
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

// Per-node write-driven speculation is out of policy under the param-only
// narrowing registry. The engine-parameterized describe that exercised
// `observeRuntimeWrite` → speculative typeNarrowing fact was removed with
// the architectural switch; param-driven observation is covered in
// speculative-narrowing.test.ts.

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
    observeRuntimeWrite(reactive, assign.value.id, 42, ROOT_CONTEXT);
    const after = readExprFact(
      reactive.topology,
      typeAnalysis, assign.value.id, ROOT_CONTEXT);
    const specCtx = reactive.specAssumptionChainForNode(assign.value.id);
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
        reactive.observe(runtimeCallAnalysis, scopeId, next, ROOT_CONTEXT);
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
        observeRuntimeReturn(reactive, scopeId, value, ROOT_CONTEXT);
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
      nodeId => reactive.specAssumptionChainForNode(nodeId),
      unit => reactive.specAssumptionChainFor(unit),
    ).entryRequirementsOf(fDef.id);
    expect(reqs).toBeDefined();
    expect(reqs!.provable.get(0)?.kinds).toBe(INT_BIT);
  });
});
