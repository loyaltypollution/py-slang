import { constAnalysisModule } from "../const-analysis/analysis";
import type { ConstLattice } from "../const-analysis/lattice";
import { typeAnalysisModule } from "../type-analysis/analysis";
import type { TypeLattice } from "../type-analysis/lattice";
import { transferBlock } from "./block-transfer";
import type { BasicBlock } from "./cfg";
import { nodeIdToBlock, type DfaBlockFact, makeBlockFixpointAnalysis } from "./dfa-factory";
import type { BlockDfaSpec } from "./interfaces";
import { MutableEnv } from "./mutable-env";
import { addEdge, type Analysis } from "./analysis";
import { runtimeWriteAnalysis } from "./runtime-analyses";

function dfaAnalysis<L>(
  debugName: string,
  spec: BlockDfaSpec<L>,
): Analysis<BasicBlock, DfaBlockFact<L>> {
  const analysis = makeBlockFixpointAnalysis<L>({
    debugName,
    direction: spec.direction,
    valueLattice: spec,
    mergeKind: spec.mergeKind,
    seedEnv: () => new MutableEnv<L>(),
    transferBlock: (factStore, ctx, block, inEnv, unit) =>
      transferBlock(block, inEnv, spec, factStore, unit.slotLookup, ctx.currentContext),
    refineOnEdge: (env, edge) => spec.refineOnEdge(env, edge),
  });
  // Monotone widening edge: a ROOT observation change wakes the containing
  // block so the static/widened fact can advance. Speculative narrowing
  // rides the Context dimension instead — see the observation→context
  // translator on Worklist.
  addEdge(analysis, { on: "fact", analysis: runtimeWriteAnalysis, wake: nodeIdToBlock });
  return analysis;
}

export const typeAnalysis: Analysis<BasicBlock, DfaBlockFact<TypeLattice>> =
  dfaAnalysis("typeAnalysis", typeAnalysisModule);
export const constAnalysis: Analysis<BasicBlock, DfaBlockFact<ConstLattice>> =
  dfaAnalysis("constAnalysis", constAnalysisModule);
