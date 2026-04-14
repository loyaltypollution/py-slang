import { constAnalysisModule } from "../const-analysis/analysis";
import type { ConstLattice } from "../const-analysis/lattice";
import { typeAnalysisModule } from "../type-analysis/analysis";
import type { TypeLattice } from "../type-analysis/lattice";
import { transferBlock } from "./block-transfer";
import type { BasicBlock } from "./cfg";
import { nodeIdToBlock, type DfaBlockFact, makeBlockFixpointPass } from "./dfa-factory";
import type { BlockDfaSpec } from "./interfaces";
import { MutableEnv } from "./mutable-env";
import { addEdge, type Pass } from "./pass";
import { runtimeWritePass } from "./runtime-passes";

function dfaPass<L>(
  debugName: string,
  spec: BlockDfaSpec<L>,
): Pass<BasicBlock, DfaBlockFact<L>> {
  const pass = makeBlockFixpointPass<L>({
    debugName,
    direction: spec.direction,
    valueLattice: spec,
    mergeKind: spec.mergeKind,
    seedEnv: () => new MutableEnv<L>(),
    transferBlock: (ctx, block, inEnv, unit) =>
      transferBlock(block, inEnv, spec, ctx.factStore, unit.slotLookup),
    refineOnEdge: (env, edge) => spec.refineOnEdge(env, edge),
  });
  addEdge(pass, { on: "fact", pass: runtimeWritePass, wake: nodeIdToBlock });
  return pass;
}

export const typeAnalysisPass: Pass<BasicBlock, DfaBlockFact<TypeLattice>> =
  dfaPass("typeAnalysis", typeAnalysisModule);
export const constAnalysisPass: Pass<BasicBlock, DfaBlockFact<ConstLattice>> =
  dfaPass("constAnalysis", constAnalysisModule);
