import { StmtNS } from "../../../ast-types";
import type {
  Analysis,
  AnalysisCtx,
  JoinSemiLattice,
  Lattice,
} from "../../../specialization/framework/analysis";
import type { BasicBlock } from "../../../specialization/program/basic-block";
import {
  makeBlockFixpointAnalysis,
  type BlockFixpointAnalysis,
} from "../../../specialization/analysis/dfa-factory";
import type { Function } from "../../../specialization/program/function/function";
import { MutableEnv } from "../../../specialization/analysis/block-env";
import type { Worklist } from "../../../specialization/framework/worklist";
import { setupWithAnalyses } from "./compile-pipelines";

export const intMaxLattice: JoinSemiLattice<number> = {
  bottom: 0,
  leq: (a, b) => a <= b,
  join: (a, b) => Math.max(a, b),
  eq: (a, b) => a === b,
};

export const intLattice: Lattice<number> = {
  ...intMaxLattice,
  top: 2,
  meet: (a, b) => Math.min(a, b),
};

export interface SyntheticDfaOpts {
  name: string;
  direction: "forward" | "backward";
  mergeKind: "may" | "must";
}

export function syntheticDfa(opts: SyntheticDfaOpts): BlockFixpointAnalysis<number> {
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

/** Parse + build a Worklist over the given analyses, drain, return the
 *  unit for the first FunctionDef in the program. */
export function buildFirstFunctionUnit(
  code: string,
  analyses: ReadonlyArray<Analysis<any, any>>,
): { unit: Function; worklist: Worklist } {
  const { ast, worklist } = setupWithAnalyses(code, analyses);
  worklist.drain();
  const fn = ast.statements[0] as StmtNS.FunctionDef;
  return { unit: worklist.locate.functionById(fn.id)!, worklist };
}
