// Narrowings for the entry-parameter speculation dimension.
//
// Declared here (inside framework/) so that:
//   - framework/dfa-analyses.ts (DEFAULT_NARROWINGS / JIT_RELEVANT_NARROWINGS)
//   - const-analysis and type-analysis (context-aware param slot lookups via
//     `findAssumption`)
// all import from the same canonical location without a cross-layer dependency.
//
// The per-narrowing identity fields (id, debugName, keySpace, eq) used to
// live on a separate `AssumptionHandle` object; they are now merged directly
// onto the `Narrowing` object. Production `findAssumption` / `extendContext`
// callers pass these narrowings as their AssumptionHandle argument —
// `Narrowing extends AssumptionHandle`, so no casts are needed.
//
// `blockAnalysis` and `lineageValue` are thunks: the narrowing references
// `typeAnalysis` / `constAnalysis` (type- and const-analysis modules) and
// `contextIsEntrySpecializable` (entry-guards), which all import back from
// this module. ESM live bindings make the cycle safe as long as the imports
// are only dereferenced after all modules finish loading — which is what
// the thunks guarantee.

import type { Narrowing, AnalysisCtx } from "./analysis";
import { findAssumption } from "./context";
import { constEq, type ConstLattice } from "../const-analysis/lattice";
import { liftConst, constAnalysis } from "../const-analysis/analysis";
import { eq as typeEq, type TypeLattice } from "../type-analysis/lattice";
import { liftType, typeAnalysis } from "../type-analysis/analysis";
import { contextIsEntrySpecializable } from "../entry-guards";
import { runtimeParamAnalysis } from "./runtime-analyses";
import { paramKeyFunctionId, type ParamKey } from "./key-spaces";
import type { Unit } from "./function-unit";

const resolveParamUnit = (ctx: AnalysisCtx, key: ParamKey): Unit | undefined =>
  ctx.topology.unitOfFunctionId(paramKeyFunctionId(key));

export const paramConstNarrowing: Narrowing<ParamKey, ConstLattice> = {
  id: Symbol("paramConstNarrowing"),
  debugName: "paramConstNarrowing",
  keySpace: "paramKey",
  eq: constEq,
  blockAnalysis: () => constAnalysis,
  observationSource: runtimeParamAnalysis,
  resolveUnit: resolveParamUnit,
  lineageValue: (unit, key, context) =>
    contextIsEntrySpecializable(unit, context)
      ? findAssumption(context, paramConstNarrowing, key)
      : undefined,
  lift: liftConst,
};

export const paramTypeNarrowing: Narrowing<ParamKey, TypeLattice> = {
  id: Symbol("paramTypeNarrowing"),
  debugName: "paramTypeNarrowing",
  keySpace: "paramKey",
  eq: typeEq,
  blockAnalysis: () => typeAnalysis,
  observationSource: runtimeParamAnalysis,
  resolveUnit: resolveParamUnit,
  lineageValue: (unit, key, context) =>
    contextIsEntrySpecializable(unit, context)
      ? findAssumption(context, paramTypeNarrowing, key)
      : undefined,
  lift: liftType,
};

