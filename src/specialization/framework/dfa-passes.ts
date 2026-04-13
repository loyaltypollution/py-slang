import { ConstAnalysisPass } from "../const-analysis/analysis";
import type { ConstLattice } from "../const-analysis/lattice";
import { TypeAnalysisPass } from "../type-analysis/analysis";
import type { TypeLattice } from "../type-analysis/lattice";
import { transferBlock } from "./block-transfer";
import { makeBlockFixpointPass, type DfaPasses } from "./dfa-factory";
import { MutableEnv } from "./mutable-env";
import { runtimeWritePass } from "./runtime-passes";

/**
 * Singleton AnalysisPass module instances. The factory closes over these to
 * share top/bottom/lattice ops with the legacy driver during the migration
 * window. Once the legacy driver is deleted, the AnalysisPass interface can
 * fold its lattice surface directly into DfaConfig.
 */
const TYPE_MODULE = new TypeAnalysisPass();
const CONST_MODULE = new ConstAnalysisPass();

export const typeAnalysisDfa: DfaPasses<TypeLattice> = makeBlockFixpointPass<TypeLattice>({
  debugName: "typeAnalysis",
  direction: TYPE_MODULE.direction,
  bottom: TYPE_MODULE.bottom(),
  top: TYPE_MODULE.top(),
  leq: (a, b) => TYPE_MODULE.leq(a, b),
  join: (a, b) => TYPE_MODULE.join(a, b),
  meet: (a, b) => TYPE_MODULE.meet(a, b),
  mergeKind: TYPE_MODULE.mergeKind,
  reads: [runtimeWritePass],
  seedEnv: () => new MutableEnv<TypeLattice>(),
  transferBlock: (ctx, block, inEnv, unit) =>
    transferBlock(block, inEnv, TYPE_MODULE, ctx.factStore, unit.slotLookup),
  projectNode: (ctx, unit, nodeId, inEnv, block) => {
    let result: TypeLattice | undefined;
    transferBlock(
      block,
      inEnv,
      TYPE_MODULE,
      ctx.factStore,
      unit.slotLookup,
      (id, val) => {
        if (id === nodeId) result = val;
      },
    );
    return result;
  },
});

export const constAnalysisDfa: DfaPasses<ConstLattice> = makeBlockFixpointPass<ConstLattice>({
  debugName: "constAnalysis",
  direction: CONST_MODULE.direction,
  bottom: CONST_MODULE.bottom(),
  top: CONST_MODULE.top(),
  leq: (a, b) => CONST_MODULE.leq(a, b),
  join: (a, b) => CONST_MODULE.join(a, b),
  meet: (a, b) => CONST_MODULE.meet(a, b),
  mergeKind: CONST_MODULE.mergeKind,
  reads: [runtimeWritePass],
  seedEnv: () => new MutableEnv<ConstLattice>(),
  transferBlock: (ctx, block, inEnv, unit) =>
    transferBlock(block, inEnv, CONST_MODULE, ctx.factStore, unit.slotLookup),
  projectNode: (ctx, unit, nodeId, inEnv, block) => {
    let result: ConstLattice | undefined;
    transferBlock(
      block,
      inEnv,
      CONST_MODULE,
      ctx.factStore,
      unit.slotLookup,
      (id, val) => {
        if (id === nodeId) result = val;
      },
    );
    return result;
  },
});
