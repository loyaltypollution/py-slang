import { liftType, typeAnalysis } from "../analysis/type/analysis";
import { eq as typeEq, type TypeLattice } from "../analysis/type/lattice";
import type { Narrowing } from "../framework/analysis";
import type { RawKind } from "../observation/raw-value";
import { runtimeParamSource } from "../observation/runtime-analyses";
import type { FunctionLocator } from "../program/function/manager";
import { paramKeyFunctionId, type ParamKey } from "./param-key";

/** Per-parameter type narrowing. Runtime parameter observations lift to
 *  `TypeLattice` and extend the owning function's context with
 *  `(paramTypeNarrowing, paramKey, type)`. The corresponding analysis
 *  (`typeAnalysis`) reseeds at the entry block on every chain change. */
export const paramTypeNarrowing: Narrowing<ParamKey, TypeLattice, RawKind> = {
  eq: typeEq,
  blockAnalysis: () => typeAnalysis,
  source: runtimeParamSource,
  lift: liftType,
  resolveUnit: (locator: FunctionLocator, key: ParamKey) =>
    locator.functionById(paramKeyFunctionId(key)),
};
