import { liftType, typeAnalysis } from "../analysis/type/analysis";
import { eq as typeEq, type TypeLattice } from "../analysis/type/lattice";
import type { NarrowingBinding } from "../framework/analysis";
import type { ObservationBinding } from "../observation/observation-binding";
import type { RawKind } from "../observation/raw-value";
import { runtimeParamSource } from "../observation/runtime-analyses";
import type { Function } from "../program/units/function/function";
import type { FunctionLocator } from "../program/units/function/manager";
import { paramKeyFunctionId, type ParamKey } from "./param-key";

export const paramTypeNarrowing: NarrowingBinding<ParamKey, TypeLattice> = {
  eq: typeEq,
  blockAnalysis: () => typeAnalysis,
};

export const paramTypeBinding: ObservationBinding<
  Function,
  FunctionLocator,
  ParamKey,
  TypeLattice,
  RawKind
> = {
  narrowing: paramTypeNarrowing,
  source: runtimeParamSource,
  lift: liftType,
  resolveUnit: (locator, key) => locator.functionById(paramKeyFunctionId(key)),
};
