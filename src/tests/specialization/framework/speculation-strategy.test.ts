// P4 validation: a new speculation policy is a single-file addition with
// zero analysis edits. This test exercises `countBasedStrategy` against a
// real Worklist and proves the threshold gate works end-to-end without
// `typeAnalysis`, `constAnalysis`, or any transform having been touched.

import { ExprNS, StmtNS } from "../../../ast-types";
import { parse } from "../../../parser/parser-adapter";
import { analyzeWithEnvironments } from "../../../resolver";
import { typeAnalysis } from "../../../specialization/framework/dfa-analyses";
import { readExprFact } from "../../../specialization/framework/dfa-factory";
import { runtimeWriteAnalysis } from "../../../specialization/framework/runtime-analyses";
import {
  countBasedStrategy,
  immediateStrategy,
  type SpeculationStrategy,
} from "../../../specialization/framework/speculation-strategy";
import { Worklist, DEFAULT_PASSES, DEFAULT_TRANSFORMS } from "../../../specialization/framework/worklist";
import { INT_BIT } from "../../../specialization/type-analysis/lattice";

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
    const xRead = (fn.body[0] as StmtNS.Assign).value as ExprNS.Variable;
    const block = worklist.topology.blockOfNode(xRead.id)!;
    const unit = block.unit;

    expect(worklist.specContextFor(unit)).toBe(
      worklist.specContextForNode(xRead.id),
    );

    worklist.observe(runtimeWriteAnalysis, xRead.id, { kind: "number", value: 5 });
    worklist.drain();

    const narrowed = readExprFact(
      worklist.topology,
      typeAnalysis,
      xRead.id,
      worklist.specContextForNode(xRead.id),
    );
    expect(narrowed?.kinds).toBe(INT_BIT);
  });

  test("countBasedStrategy(3): first two observations do not extend the context; third does", () => {
    const { ast, worklist } = buildWith(countBasedStrategy(3), SOURCE);
    const fn = ast.statements[0] as StmtNS.FunctionDef;
    const xRead = (fn.body[0] as StmtNS.Assign).value as ExprNS.Variable;
    const block = worklist.topology.blockOfNode(xRead.id)!;
    const unit = block.unit;

    // First two identical observations: counter advances but no extension.
    worklist.observe(runtimeWriteAnalysis, xRead.id, { kind: "number", value: 5 });
    worklist.drain();
    expect(worklist.specContextFor(unit).depth).toBe(0);

    worklist.observe(runtimeWriteAnalysis, xRead.id, { kind: "number", value: 5 });
    worklist.drain();
    expect(worklist.specContextFor(unit).depth).toBe(0);

    // Third identical observation crosses the threshold — context extends.
    worklist.observe(runtimeWriteAnalysis, xRead.id, { kind: "number", value: 5 });
    worklist.drain();
    expect(worklist.specContextFor(unit).depth).toBeGreaterThan(0);

    const narrowed = readExprFact(
      worklist.topology,
      typeAnalysis,
      xRead.id,
      worklist.specContextForNode(xRead.id),
    );
    expect(narrowed?.kinds).toBe(INT_BIT);
  });

  test("countBasedStrategy: differing values at the same site count separately", () => {
    const { ast, worklist } = buildWith(countBasedStrategy(3), SOURCE);
    const fn = ast.statements[0] as StmtNS.FunctionDef;
    const xRead = (fn.body[0] as StmtNS.Assign).value as ExprNS.Variable;
    const block = worklist.topology.blockOfNode(xRead.id)!;
    const unit = block.unit;

    // Mixed observations never let any single discriminant reach threshold.
    worklist.observe(runtimeWriteAnalysis, xRead.id, { kind: "number", value: 1 });
    worklist.observe(runtimeWriteAnalysis, xRead.id, { kind: "number", value: 2 });
    worklist.observe(runtimeWriteAnalysis, xRead.id, { kind: "number", value: 3 });
    worklist.observe(runtimeWriteAnalysis, xRead.id, { kind: "number", value: 4 });
    worklist.drain();

    // Each observation widens the runtimeWriteAnalysis lattice to ⊤ long
    // before the counter could act, but even if it hadn't, no single
    // discriminant hit 3 — spec context should remain at ROOT.
    expect(worklist.specContextFor(unit).depth).toBe(0);
  });
});
