import { ConstAnalysisPass } from "../const-analysis/analysis";
import type { ConstLattice } from "../const-analysis/lattice";
import { TypeAnalysisPass } from "../type-analysis/analysis";
import type { TypeLattice } from "../type-analysis/lattice";
import { transferBlock } from "./block-transfer";
import { makeBlockFixpointPass, type DfaPasses } from "./dfa-factory";
import { MutableEnv } from "./mutable-env";
import { runtimeWritePass } from "./runtime-passes";

const TYPE_MODULE = new TypeAnalysisPass();
const CONST_MODULE = new ConstAnalysisPass();

export const typeAnalysisDfa: DfaPasses<TypeLattice> = makeBlockFixpointPass<TypeLattice>({
  debugName: "typeAnalysis",
  direction: TYPE_MODULE.direction,
  top: TYPE_MODULE.top(),
  leq: (a, b) => TYPE_MODULE.leq(a, b),
  join: (a, b) => TYPE_MODULE.join(a, b),
  meet: (a, b) => TYPE_MODULE.meet(a, b),
  mergeKind: TYPE_MODULE.mergeKind,
  reads: [runtimeWritePass],
  seedEnv: () => new MutableEnv<TypeLattice>(),
  transferBlock: (ctx, block, inEnv, unit) =>
    transferBlock(block, inEnv, TYPE_MODULE, ctx.factStore, unit.slotLookup),
});

export const constAnalysisDfa: DfaPasses<ConstLattice> = makeBlockFixpointPass<ConstLattice>({
  debugName: "constAnalysis",
  direction: CONST_MODULE.direction,
  top: CONST_MODULE.top(),
  leq: (a, b) => CONST_MODULE.leq(a, b),
  join: (a, b) => CONST_MODULE.join(a, b),
  meet: (a, b) => CONST_MODULE.meet(a, b),
  mergeKind: CONST_MODULE.mergeKind,
  reads: [runtimeWritePass],
  seedEnv: () => new MutableEnv<ConstLattice>(),
  transferBlock: (ctx, block, inEnv, unit) =>
    transferBlock(block, inEnv, CONST_MODULE, ctx.factStore, unit.slotLookup),
});
