import { type Narrowing } from "../framework/analysis";
import { asProgramCtx } from "../program/program-ctx";
import { paramKeyFunctionId, type ParamKey } from "./param-key";
import { eq as typeEq, type TypeLattice } from "../analysis/type/lattice";
import { liftType, typeAnalysis } from "../analysis/type/analysis";
import type { ObservationBinding } from "../observation/observation-binding";
import type { RawKind } from "../observation/raw-value";
import { runtimeParamChannel } from "../observation/runtime-analyses";

export const paramTypeNarrowing: Narrowing<ParamKey, TypeLattice> = {
  eq: typeEq,
  blockAnalysis: () => typeAnalysis,
};

export const paramTypeBinding: ObservationBinding<ParamKey, TypeLattice, RawKind> = {
  narrowing: paramTypeNarrowing,
  source: runtimeParamChannel,
  lift: liftType,
  resolveUnit: (ctx, key) => asProgramCtx(ctx).functions.get(paramKeyFunctionId(key)),
};
