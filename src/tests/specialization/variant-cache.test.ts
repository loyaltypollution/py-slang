import { StmtNS } from "../../ast-types";
import { ROOT_CONTEXT, type AssumptionChain } from "../../specialization/assumption/chain";
import { paramKey } from "../../specialization/narrowing-policy/param-key";
import { runtimeParamSource } from "../../specialization/observation/runtime-analyses";
import { forkBody } from "../../specialization/speculation/assumption-bodies";
import type { Function } from "../../specialization/program/function/function";
import { setupAndDrain } from "./harness/compile-pipelines";

type SpecializedFunction = {
  function: Function;
  worklist: ReturnType<typeof setupAndDrain>["worklist"];
  chainX: AssumptionChain;
  chainXY: AssumptionChain;
};

function specializeBooleanPair(): SpecializedFunction {
  const { ast, worklist } = setupAndDrain(`
def f(x, y):
    if x:
        if y:
            return 1
        else:
            return 2
    return 0
`);
  const fd = ast.statements[0] as StmtNS.FunctionDef;
  const function = worklist.locate.functionById(fd.id)!;
  const chainX = worklist.observe(
    runtimeParamSource,
    paramKey(fd.id, 0),
    { kind: "bool", value: true },
    ROOT_CONTEXT,
  );
  const chainXY = worklist.observe(
    runtimeParamSource,
    paramKey(fd.id, 1),
    { kind: "bool", value: true },
    chainX,
  );
  return { function, worklist, chainX, chainXY };
}

describe("speculative variant cache", () => {
  test("ancestor rewrite invalidates a pre-existing descendant fork", () => {
    const { function, worklist, chainX, chainXY } = specializeBooleanPair();

    forkBody(function, chainX);
    const staleDescendant = forkBody(function, chainXY);
    expect(staleDescendant).toHaveLength(2);

    worklist.sweepTransforms();

    const refreshedDescendant = forkBody(function, chainXY);
    expect(refreshedDescendant).not.toBe(staleDescendant);
    expect(refreshedDescendant[0]).toBeInstanceOf(StmtNS.Return);
    expect(staleDescendant[0]).toBeInstanceOf(StmtNS.If);
  });

  test("speculative-only rewrites do not schedule canonical rebuilds", () => {
    const { worklist } = specializeBooleanPair();
    const rebuilds: Function[] = [];

    worklist.functions.onExtentChange((function, prev) => {
      if (prev.size > 0) {
        rebuilds.push(function);
      }
    });

    worklist.sweepTransforms();
    worklist.drain();

    expect(rebuilds).toEqual([]);
  });
});
