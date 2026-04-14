import { constAnalysisModule } from "../const-analysis/analysis";
import type { ConstLattice } from "../const-analysis/lattice";
import { typeAnalysisModule } from "../type-analysis/analysis";
import type { TypeLattice } from "../type-analysis/lattice";
import { transferBlock } from "./block-transfer";
import type { BasicBlock } from "./cfg";
import { type DfaBlockFact, makeBlockFixpointPass } from "./dfa-factory";
import type { AnalysisPass } from "./interfaces";
import { MutableEnv } from "./mutable-env";
import type { Pass } from "./pass";
import { runtimeWritePass } from "./runtime-passes";

function makeDfa<L>(debugName: string, spec: AnalysisPass<L>): Pass<BasicBlock, DfaBlockFact<L>> {
  return makeBlockFixpointPass<L>({
    debugName,
    direction: spec.direction,
    top: spec.top(),
    leq: spec.leq,
    join: spec.join,
    meet: spec.meet,
    mergeKind: spec.mergeKind,
    reads: [runtimeWritePass],
    seedEnv: () => new MutableEnv<L>(),
    transferBlock: (ctx, block, inEnv, unit) =>
      transferBlock(block, inEnv, spec, ctx.factStore, unit.slotLookup),
  });
}

export const typeAnalysisPass: Pass<BasicBlock, DfaBlockFact<TypeLattice>> = makeDfa(
  "typeAnalysis",
  typeAnalysisModule,
);
export const constAnalysisPass: Pass<BasicBlock, DfaBlockFact<ConstLattice>> = makeDfa(
  "constAnalysis",
  constAnalysisModule,
);
