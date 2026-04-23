// Narrowings for the entry-parameter speculation dimension.
//
// Declared here (inside framework/) so that:
//   - framework/dfa-analyses.ts (DEFAULT_NARROWINGS)
//   - const-analysis and type-analysis (context-aware param slot lookups via
//     `findAssumption`)
// all import from the same canonical location without a cross-layer dependency.
//
// The narrowing is the AssumptionHandle: `Narrowing extends AssumptionHandle`,
// so production `findAssumption` / `extendContext` callers pass these
// narrowings directly. Identity is object-reference — narrowings are module
// singletons; the context interner assigns a per-process ordinal for
// canonical chain ordering, and `eq` is the value-equality relation the
// interner uses to dedup `(narrowing, key, value)` triples.
//
// `blockAnalysis` and `lineageValue` are thunks: the narrowing references
// `typeAnalysis` / `constAnalysis` (type- and const-analysis modules) and
// `contextIsEntrySpecializable` (entry-guards), which all import back from
// this module. ESM live bindings make the cycle safe as long as the imports
// are only dereferenced after all modules finish loading — which is what
// the thunks guarantee.

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

