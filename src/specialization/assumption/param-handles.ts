// Narrowings for the entry-parameter speculation dimension. Declared here
// (inside assumption/) so framework/narrowing-registry.ts and
// const/type-analysis all import from the same canonical location. Identity is object-
// reference; the context interner dedups `(narrowing, key, value)` triples
// via `eq`.
//
// `blockAnalysis` is a thunk: the narrowing references typeAnalysis /
// constAnalysis, which import back from this module. ESM live bindings
// make the cycle safe as long as the imports are only dereferenced after
// module loading completes.

import type { Narrowing } from "../framework/analysis";
import { constEq, type ConstLattice } from "../const-analysis/lattice";
import { liftConst, constAnalysis } from "../const-analysis/analysis";
import { eq as typeEq, type TypeLattice } from "../type-analysis/lattice";
import { liftType, typeAnalysis } from "../type-analysis/analysis";
import { runtimeParamChannel } from "./runtime-analyses";
import { paramKeyFunctionId, type ParamKey } from "../framework/key-spaces";

// Both narrowings resolve the owning unit the same way: ParamKey encodes
// the functionId in its prefix.
const resolveUnit: Narrowing<ParamKey, unknown>["resolveUnit"] = (ctx, key) =>
  ctx.topology.unitOfFunctionId(paramKeyFunctionId(key));

export const paramConstNarrowing: Narrowing<ParamKey, ConstLattice> = {
  eq: constEq,
  blockAnalysis: () => constAnalysis,
  observationSource: runtimeParamChannel,
  resolveUnit,
  lift: liftConst,
};

export const paramTypeNarrowing: Narrowing<ParamKey, TypeLattice> = {
  eq: typeEq,
  blockAnalysis: () => typeAnalysis,
  observationSource: runtimeParamChannel,
  resolveUnit,
  lift: liftType,
};
