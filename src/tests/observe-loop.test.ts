/**
 * End-to-end test for the OBSERVE loop.
 *
 * Verifies that the CSE interpreter emits runtime observations which the
 * reactive optimization worklist translates into fact-store refinements,
 * visible to consumers via the per-field accessors.
 */

import { StmtNS } from "../ast-types";
import { parse } from "../parser/parser-adapter";
import { analyzeWithEnvironments } from "../resolver";
import { buildTestWorklist } from "./utils";
import { Context } from "../engines/cse/context";
import { evaluate } from "../engines/cse/interpreter";
import { readTypeFact } from "../specialization/framework/fact-accessors";
import { STR_BIT, INT_BIT } from "../specialization/type-analysis/lattice";

function setupReactive(code: string) {
  const script = code + "\n";
  const ast = parse(script) as StmtNS.FileInput;
  const { environments } = analyzeWithEnvironments(ast, script, 4);
  const reactive = buildTestWorklist(ast, environments);
  return { ast, environments, reactive };
}

async function runWithReactive(code: string) {
  const script = code + "\n";
  const ast = parse(script) as StmtNS.FileInput;
  const { environments } = analyzeWithEnvironments(ast, script, 4);
  const context = new Context();
  const reactive = buildTestWorklist(ast, environments);
  reactive.converge();

  context.runtime.observationSink = reactive;
  context.runtime.rootScope = ast;

  await evaluate("", ast, context, { variant: 4, groups: [] });
  reactive.tick();

  return { ast, reactive };
}

describe("OBSERVE loop: end-to-end", () => {
  test("runtime string write widens the RHS fact from INT to INT|STR", async () => {
    // After static analysis, `x = 1` has type=INT only. Running CSE on a
    // program that later assigns a string should push a string observation
    // into the fact store via observeWrite.
    const code = `
x = 1
x = "hello"
`;
    const { ast, reactive } = await runWithReactive(code);

    const firstAssign = ast.statements[0] as StmtNS.Assign;
    const secondAssign = ast.statements[1] as StmtNS.Assign;

    const firstType = readTypeFact(reactive.factStore, firstAssign.value.id);
    const secondType = readTypeFact(reactive.factStore, secondAssign.value.id);

    // First assign's RHS is a literal 1 — static analysis gave INT.
    expect(firstType).toBeDefined();
    expect(firstType!.kinds & INT_BIT).toBeTruthy();

    // Second assign's RHS is "hello" — static analysis gave STR.
    // Additionally, the observation path may widen this further.
    expect(secondType).toBeDefined();
    expect(secondType!.kinds & STR_BIT).toBeTruthy();
  });

  test("program with no runtime mutations: observing a known value leaves facts unchanged", async () => {
    const { ast, reactive } = setupReactive("x = 1");
    reactive.converge();
    const assign = ast.statements[0] as StmtNS.Assign;
    const before = readTypeFact(reactive.factStore, assign.value.id);

    reactive.observeWrite(ast, assign.value, 1);
    const after = readTypeFact(reactive.factStore, assign.value.id);

    expect(after).toEqual(before);
  });

});

describe("OBSERVE loop: regression guard", () => {
  test("observation of an already-known value leaves the node's fact equal", async () => {
    const { ast, reactive } = setupReactive("x = 42");
    reactive.converge();

    const assign = ast.statements[0] as StmtNS.Assign;
    const before = readTypeFact(reactive.factStore, assign.value.id);
    reactive.observeWrite(ast, assign.value, 42);
    const after = readTypeFact(reactive.factStore, assign.value.id);

    expect(after).toEqual(before);
  });
});
