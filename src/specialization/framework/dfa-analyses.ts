import { constAnalysisModule, constExprHandle, liftConst } from "../const-analysis/analysis";
import type { ConstLattice } from "../const-analysis/lattice";
import { liftType, typeAnalysisModule, typeExprHandle } from "../type-analysis/analysis";
import type { TypeLattice } from "../type-analysis/lattice";
import {
  contextIsEntrySpecializable,
  paramConstHandle,
  paramTypeHandle,
} from "../entry-guards";
import {
  returnKindHandle,
  returnKindNarrowing,
  typeRequirementAnalysis,
} from "../type-requirement-analysis/analysis";
import { findAssumption } from "./context";
import { transferBlock } from "./block-transfer";
import { makeBlockFixpointAnalysis, type BlockFixpointAnalysis } from "./dfa-factory";
import type { BlockDfaSpec } from "./interfaces";
import { MutableEnv } from "./mutable-env";
import type { AnalysisCtx, Narrowing } from "./analysis";
import {
  paramKeyFunctionId,
  type FunctionId,
  type NodeId,
  type ParamKey,
} from "./key-spaces";
import { runtimeParamAnalysis, runtimeWriteAnalysis } from "./runtime-analyses";

function dfaAnalysis<L>(
  debugName: string,
  spec: BlockDfaSpec<L>,
): BlockFixpointAnalysis<L> {
  return makeBlockFixpointAnalysis<L>({
    debugName,
    direction: spec.direction,
    valueLattice: spec,
    mergeKind: spec.mergeKind,
    seedEnv: () => new MutableEnv<L>(),
    transferBlock: (ctx, block, inEnv, unit) =>
      transferBlock(block, inEnv, spec, unit, ctx.currentContext),
    refineOnEdge: (env, edge) => spec.refineOnEdge(env, edge),
  });
}

export const typeAnalysis: BlockFixpointAnalysis<TypeLattice> =
  dfaAnalysis("typeAnalysis", typeAnalysisModule);
export const constAnalysis: BlockFixpointAnalysis<ConstLattice> =
  dfaAnalysis("constAnalysis", constAnalysisModule);

const resolveParamUnit = (ctx: AnalysisCtx, key: ParamKey) =>
  ctx.topology.unitOfFunctionId(paramKeyFunctionId(key));

/** Narrowing dimensions exposed to the observation→context translator.
 *  Registering one here is the full surface for adding a speculation
 *  dimension: the worklist's observation translator, widen primitives,
 *  and `lineageOf` iterate this list. No framework edits required. */
export const paramTypeNarrowing: Narrowing<ParamKey, TypeLattice> = {
  handle: paramTypeHandle,
  blockAnalysis: () => typeAnalysis,
  observationSource: runtimeParamAnalysis,
  resolveUnit: resolveParamUnit,
  lineageValue: (unit, key, context) =>
    contextIsEntrySpecializable(unit, context)
      ? findAssumption(context, paramTypeHandle, key)
      : undefined,
  lift: liftType,
};
export const paramConstNarrowing: Narrowing<ParamKey, ConstLattice> = {
  handle: paramConstHandle,
  blockAnalysis: () => constAnalysis,
  observationSource: runtimeParamAnalysis,
  resolveUnit: resolveParamUnit,
  lineageValue: (unit, key, context) =>
    contextIsEntrySpecializable(unit, context)
      ? findAssumption(context, paramConstHandle, key)
      : undefined,
  lift: liftConst,
};

export const typeNarrowing: Narrowing<NodeId, TypeLattice> = {
  handle: typeExprHandle,
  blockAnalysis: () => typeAnalysis,
  observationSource: runtimeWriteAnalysis,
  lift: liftType,
};
export const constNarrowing: Narrowing<NodeId, ConstLattice> = {
  handle: constExprHandle,
  blockAnalysis: () => constAnalysis,
  observationSource: runtimeWriteAnalysis,
  lift: liftConst,
};

/** Default narrowing set. Worklist callers that omit the constructor's
 *  `narrowings` parameter get this list.
 *
 *  The return-kind dimension is keyed in a different space (functionId, sourced
 *  from `runtimeReturnAnalysis`) than the node-keyed type/const dimensions
 *  (sourced from `runtimeWriteAnalysis`). The observation translator
 *  filters on `observationSource` so they never cross-trigger. */
export const DEFAULT_NARROWINGS: ReadonlyArray<Narrowing<NodeId | FunctionId | ParamKey, unknown>> = [
  paramTypeNarrowing,
  paramConstNarrowing,
  typeNarrowing,
  constNarrowing,
  returnKindNarrowing,
];

/** Narrowings that currently affect SVML code generation. Write-driven type
 *  narrowings remain available in speculation contexts and lineage pruning,
 *  but the backend does not consume speculative type facts directly, so the
 *  JIT should not treat them as artifact-shaping inputs. */
export const JIT_RELEVANT_NARROWINGS: ReadonlyArray<Narrowing<NodeId | FunctionId | ParamKey, unknown>> = [
  paramTypeNarrowing,
  paramConstNarrowing,
  constNarrowing,
  returnKindNarrowing,
];

export { returnKindHandle, returnKindNarrowing, typeRequirementAnalysis };
