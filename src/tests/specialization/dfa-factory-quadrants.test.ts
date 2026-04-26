import {
  defineAnalysis,
  type Analysis,
} from "../../specialization/framework/analysis";
import type { BasicBlock } from "../../specialization/program/basic-block";
import { ROOT_CONTEXT } from "../../specialization/assumption/chain";
import {
  buildFirstFunctionFunction,
  intMaxLattice,
  syntheticDfa,
} from "./harness/synthetic-dfa";

const FN_SRC = `
def f(x):
    y = x
    return y
`;

describe("makeBlockFixpointAnalysis quadrant coverage", () => {
  test.each([
    { direction: "forward", mergeKind: "may", seed: "entry" },
    { direction: "forward", mergeKind: "must", seed: "entry" },
    { direction: "backward", mergeKind: "may", seed: "exit" },
    { direction: "backward", mergeKind: "must", seed: "exit" },
  ] as const)(
    "$direction + $mergeKind seeds the $seed block and writes paired env/facts cells",
    ({ direction, mergeKind, seed }) => {
      const analysis = syntheticDfa({
        name: `synthetic:${direction}:${mergeKind}`,
        direction,
        mergeKind,
      });
      const { function } = buildFirstFunctionFunction(FN_SRC, [analysis.env, analysis.facts]);

      const expectedSeed = seed === "entry" ? function.cfg.entry : function.cfg.exit;
      expect(analysis.seed(function)).toBe(expectedSeed);

      const seededEnv = analysis.env.store.tryRead(expectedSeed, ROOT_CONTEXT);
      expect(seededEnv).toBeDefined();
      expect(seededEnv?.get(0)).toBe(1);

      const seededFacts = analysis.facts.store.tryRead(expectedSeed, ROOT_CONTEXT);
      expect(seededFacts).toBeDefined();
      expect(seededFacts?.get(-1)).toBe(expectedSeed.stmts.length);
    },
  );

  test("paired .facts writes routed through ctx.write wake subscribers", () => {
    const analysis = syntheticDfa({
      name: "synthetic:paired-facts",
      direction: "forward",
      mergeKind: "must",
    });

    const seenBlocks: BasicBlock[] = [];
    const factsReader: Analysis<BasicBlock, number> = defineAnalysis({
      storeAlgebra: intMaxLattice,
      tier: "analysis",
      polarity: "may",
      transfer: (_ctx, key) => {
        seenBlocks.push(key);
        return 1;
      },
      bind(wl) {
        wl.subscribeOnAdvance(analysis.facts, factsReader, (_ctx, key) => [key as BasicBlock]);
      },
    });

    const { function } = buildFirstFunctionFunction(FN_SRC, [analysis.env, analysis.facts, factsReader]);

    expect(seenBlocks).toContain(analysis.seed(function));
  });
});
