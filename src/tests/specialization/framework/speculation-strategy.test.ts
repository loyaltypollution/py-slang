// P4 validation: a new speculation policy is a single-file addition with
// zero analysis edits. This test exercises `countBasedStrategy` against a
// real Worklist and proves the threshold gate works end-to-end without
// `typeAnalysis`, `constAnalysis`, or any transform having been touched.
//
// Observations drive runtimeParamAnalysis (param-only narrowing policy);
// the strategy's threshold logic is agnostic to the observation source.

import { StmtNS } from "../../../ast-types";
import { parse } from "../../../parser/parser-adapter";
import { analyzeWithEnvironments } from "../../../resolver";
import { typeAnalysis } from "../../../specialization/framework/dfa-analyses";
import { readExprFact } from "../../../specialization/framework/dfa-factory";
import { runtimeParamAnalysis } from "../../../specialization/framework/runtime-analyses";
import {
  countBasedStrategy,
  immediateStrategy,
  type SpeculationStrategy,
} from "../../../specialization/framework/speculation-strategy";
import { Worklist, DEFAULT_PASSES, DEFAULT_TRANSFORMS } from "../../../specialization/framework/worklist";
import { INT_BIT } from "../../../specialization/type-analysis/lattice";
import { paramKey } from "../../../specialization/framework/key-spaces";

function buildWith(strategy: SpeculationStrategy, src: string) {
  const script = src + "\n";
  const ast = parse(script) as StmtNS.FileInput;
  const { environments } = analyzeWithEnvironments(ast, script, 4);
  const worklist = new Worklist(
    ast,
    environments,
    DEFAULT_PASSES,
    undefined,
    DEFAULT_TRANSFORMS,
    strategy,
  );
  worklist.drain();
  return { ast, worklist };
}

const SOURCE = `
def hot(x):
    y = x
    return y * 2
`;

describe("SpeculationStrategy", () => {
  test("immediateStrategy: first observation extends the unit's spec context", () => {
    const { ast, worklist } = buildWith(immediateStrategy, SOURCE);
    const fn = ast.statements[0] as StmtNS.FunctionDef;
    const unit = worklist.topology.unitOfFunctionId(fn.id)!;
    const xReadId = ((fn.body[0] as StmtNS.Assign).value as { id: number }).id;

    worklist.observe(runtimeParamAnalysis, paramKey(fn.id, 0), { kind: "number", value: 5 });
    worklist.drain();

    expect(worklist.specAssumptionChainFor(unit).depth).toBeGreaterThan(0);
    const xRead = readExprFact(
      worklist.topology,
      typeAnalysis,
      xReadId,
      worklist.specAssumptionChainFor(unit),
    );
    // Under the param-type assumption, the x read narrows to INT.
    expect(xRead?.kinds).toBe(INT_BIT);
  });

  test("countBasedStrategy(3): first two observations do not extend the context; third does", () => {
    const { ast, worklist } = buildWith(countBasedStrategy(3), SOURCE);
    const fn = ast.statements[0] as StmtNS.FunctionDef;
    const unit = worklist.topology.unitOfFunctionId(fn.id)!;

    worklist.observe(runtimeParamAnalysis, paramKey(fn.id, 0), { kind: "number", value: 5 });
    worklist.drain();
    expect(worklist.specAssumptionChainFor(unit).depth).toBe(0);

    worklist.observe(runtimeParamAnalysis, paramKey(fn.id, 0), { kind: "number", value: 5 });
    worklist.drain();
    expect(worklist.specAssumptionChainFor(unit).depth).toBe(0);

    worklist.observe(runtimeParamAnalysis, paramKey(fn.id, 0), { kind: "number", value: 5 });
    worklist.drain();
    expect(worklist.specAssumptionChainFor(unit).depth).toBeGreaterThan(0);
  });

  test("countBasedStrategy: differing values at the same site count separately", () => {
    const { ast, worklist } = buildWith(countBasedStrategy(3), SOURCE);
    const fn = ast.statements[0] as StmtNS.FunctionDef;
    const unit = worklist.topology.unitOfFunctionId(fn.id)!;

    worklist.observe(runtimeParamAnalysis, paramKey(fn.id, 0), { kind: "number", value: 1 });
    worklist.observe(runtimeParamAnalysis, paramKey(fn.id, 0), { kind: "number", value: 2 });
    worklist.observe(runtimeParamAnalysis, paramKey(fn.id, 0), { kind: "number", value: 3 });
    worklist.observe(runtimeParamAnalysis, paramKey(fn.id, 0), { kind: "number", value: 4 });
    worklist.drain();

    // No single discriminant hit 3; chain stays at ROOT.
    expect(worklist.specAssumptionChainFor(unit).depth).toBe(0);
  });
});
