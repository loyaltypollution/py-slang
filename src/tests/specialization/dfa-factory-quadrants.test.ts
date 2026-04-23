import { StmtNS } from "../../ast-types";
import {
  defineAnalysis,
  type Analysis,
  type AnalysisCtx,
  type JoinSemiLattice,
  type Lattice,
} from "../../specialization/framework/analysis";
import type { BasicBlock } from "../../specialization/framework/cfg";
import { ROOT_CONTEXT } from "../../specialization/framework/assumption-chain";
import {
  makeBlockFixpointAnalysis,
  type BlockFixpointAnalysis,
} from "../../specialization/framework/dfa-factory";
import type { Unit } from "../../specialization/framework/function-unit";
import { MutableEnv } from "../../specialization/framework/mutable-env";
import type { Worklist } from "../../specialization/framework/worklist";
import { setupWithAnalyses } from "./harness/compile-pipelines";

function buildUnit(code: string, analyses: ReadonlyArray<Analysis<any, any>>): { unit: Unit; worklist: Worklist } {
  const { ast, worklist } = setupWithAnalyses(code, analyses);
  worklist.drain();
  const fn = ast.statements[0] as StmtNS.FunctionDef;
  return { unit: worklist.units.get(fn.id)!, worklist };
}

const intMaxLattice: JoinSemiLattice<number> = {
  bottom: 0,
  leq: (a, b) => a <= b,
  join: (a, b) => Math.max(a, b),
  eq: (a, b) => a === b,
};

const intLattice: Lattice<number> = {
  ...intMaxLattice,
  top: 2,
  meet: (a, b) => Math.min(a, b),
};

function syntheticDfa(opts: {
  name: string;
  direction: "forward" | "backward";
  mergeKind: "may" | "must";
}): BlockFixpointAnalysis<number> {
  const common = {
    direction: opts.direction,
    seedEnv: () => {
      const env = new MutableEnv<number>();
      env.set(0, 1);
      return env;
    },
    transferBlock: (_ctx: AnalysisCtx, block: BasicBlock, inEnv: MutableEnv<number>) => ({
      outEnv: inEnv.snapshot(),
      exprFacts: new Map([[-1, block.stmts.length]]),
    }),
    refineOnEdge: (env: MutableEnv<number>, _edge: BasicBlock["successorEdges"][number]) => env,
  };

  if (opts.mergeKind === "must") {
    return makeBlockFixpointAnalysis<number>({
      ...common,
      mergeKind: "must",
      valueLattice: intLattice,
    });
  }

  return makeBlockFixpointAnalysis<number>({
    ...common,
    mergeKind: "may",
    valueLattice: intMaxLattice,
  });
}

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
      const { unit } = buildUnit(
        `
def f(x):
    y = x
    return y
`,
        [analysis.env, analysis.facts],
      );

      const expectedSeed = seed === "entry" ? unit.cfg.entry : unit.cfg.exit;
      expect(analysis.seed(unit)).toBe(expectedSeed);

      const seededEnv = analysis.env.tryRead(expectedSeed, ROOT_CONTEXT);
      expect(seededEnv).toBeDefined();
      expect(seededEnv?.get(0)).toBe(1);

      const seededFacts = analysis.facts.tryRead(expectedSeed, ROOT_CONTEXT);
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

    const seenBlocks: number[] = [];
    const factsReader: Analysis<BasicBlock, number> = defineAnalysis({
      storeAlgebra: intMaxLattice,
      tier: "analysis",
      polarity: "may",
      transfer: (_ctx, key) => {
        seenBlocks.push(key.id);
        return 1;
      },
      bind(wl) {
        wl.onFactDirty(analysis.facts, factsReader, (_ctx, key) => [key as BasicBlock]);
      },
    });

    const { unit, worklist } = buildUnit(
      `
def f(x):
    y = x
    return y
`,
      [analysis.env, analysis.facts, factsReader],
    );

    expect(seenBlocks).toContain(analysis.seed(unit).id);
  });
});
