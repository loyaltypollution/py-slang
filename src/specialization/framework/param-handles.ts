// Narrowings for the entry-parameter speculation dimension. Declared here
// (inside framework/) so framework/dfa-analyses.ts and const/type-analysis
// all import from the same canonical location. Identity is object-
// reference; the context interner dedups `(narrowing, key, value)` triples
// via `eq`.
//
// `blockAnalysis` is a thunk: the narrowing references typeAnalysis /
// constAnalysis, which import back from this module. ESM live bindings
// make the cycle safe as long as the imports are only dereferenced after
// module loading completes.

import type { Narrowing, AnalysisCtx } from "./analysis";
import { constEq, type ConstLattice } from "../const-analysis/lattice";
import { liftConst, constAnalysis } from "../const-analysis/analysis";
import { eq as typeEq, type TypeLattice } from "../type-analysis/lattice";
import { liftType, typeAnalysis } from "../type-analysis/analysis";
import { runtimeParamChannel } from "./runtime-analyses";
import { paramKeyFunctionId, type ParamKey } from "./key-spaces";
import type { Unit } from "./function-unit";

const resolveParamUnit = (ctx: AnalysisCtx, key: ParamKey): Unit | undefined =>
  ctx.topology.unitOfFunctionId(paramKeyFunctionId(key));

export const paramConstNarrowing: Narrowing<ParamKey, ConstLattice> = {
  eq: constEq,
  blockAnalysis: () => constAnalysis,
  observationSource: runtimeParamChannel,
  resolveUnit: resolveParamUnit,
  lift: liftConst,
};

export const paramTypeNarrowing: Narrowing<ParamKey, TypeLattice> = {
  eq: typeEq,
  blockAnalysis: () => typeAnalysis,
  observationSource: runtimeParamChannel,
  resolveUnit: resolveParamUnit,
  lift: liftType,
};
