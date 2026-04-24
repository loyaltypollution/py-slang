// Entry-parameter narrowing dimension + its ParamKey identity space.
// Declared in narrowing-policy/ so `narrowings.ts`-free consumers (defaults,
// type analysis, entry guards, runtime channel) all import from one place.
//
// Identity is object-reference; the context interner dedups `(narrowing,
// key, value)` triples via `eq`. `blockAnalysis` is a thunk: the narrowing
// references typeAnalysis, which imports back from this module — ESM live
// bindings make the cycle safe as long as the import is only dereferenced
// after module loading completes.

import { paramKeyFunctionId, type Narrowing, type ParamKey } from "../framework/analysis";
import { eq as typeEq, type TypeLattice } from "../analysis/type/lattice";
import { liftType, typeAnalysis } from "../analysis/type/analysis";
import type { ObservationBinding } from "../observation/observation-binding";
import { runtimeParamChannel } from "../observation/runtime-analyses";

export const paramTypeNarrowing: Narrowing<ParamKey, TypeLattice> = {
  eq: typeEq,
  blockAnalysis: () => typeAnalysis,
};

/** Observation-driven binding for `paramTypeNarrowing`. Registered with the
 *  worklist via `observationBindings`; the narrowing itself is registered
 *  via `narrowings` for re-seeding. The split keeps the narrowing
 *  observation-agnostic (any ingress source can drive the same dimension). */
export const paramTypeBinding: ObservationBinding<ParamKey, TypeLattice> = {
  narrowing: paramTypeNarrowing,
  source: runtimeParamChannel,
  lift: liftType,
  resolveUnit: (ctx, key) => ctx.units.get(paramKeyFunctionId(key)),
};
