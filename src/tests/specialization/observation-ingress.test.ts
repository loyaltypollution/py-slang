import { StmtNS } from "../../ast-types";
import { parse } from "../../parser/parser-adapter";
import { analyzeWithEnvironments } from "../../resolver";
import { DEFAULT_PASSES } from "../../specialization/defaults";
import { ROOT_CONTEXT } from "../../specialization/assumption/chain";
import { Worklist } from "../../specialization/framework/worklist";
import { paramTypeNarrowing } from "../../specialization/narrowing-policy/param-handles";
import { paramKey } from "../../specialization/narrowing-policy/param-key";
import { runtimeParamSource } from "../../specialization/observation/runtime-analyses";
import math from "../../stdlib/math";
import memo from "../../stdlib/memo";
import misc from "../../stdlib/misc";

function createObservationWorklist(code: string): {
  fd: StmtNS.FunctionDef;
  worklist: Worklist;
} {
  const script = code + "\n";
  const ast = parse(script);
  const { errors, environments } = analyzeWithEnvironments(ast, script, 4, [misc, math, memo]);
  if (errors.length > 0) {
    throw errors[0];
  }

  const worklist = new Worklist({
    ast,
    functionEnvironments: environments,
    analyses: DEFAULT_PASSES,
    transforms: [],
    narrowings: [paramTypeNarrowing],
  });

  const fd = ast.statements[0];
  if (!(fd instanceof StmtNS.FunctionDef)) {
    throw new Error("Expected first statement to be a FunctionDef");
  }

  return { fd, worklist };
}

describe("observation ingress", () => {
  test("param observation works without separate source registration", () => {
    const { fd, worklist } = createObservationWorklist(`
def f(x):
    return x
`);
    const unit = worklist.locate.functionById(fd.id);
    if (unit === undefined) {
      throw new Error("Expected worklist to resolve function unit");
    }

    const chain = worklist.observe(
      runtimeParamSource,
      paramKey(fd.id, 0),
      { kind: "bool", value: true },
      ROOT_CONTEXT,
    );

    expect(chain).not.toBe(ROOT_CONTEXT);
    expect(worklist.futureDispatchChainFor(unit)).toBe(chain);
  });
});
