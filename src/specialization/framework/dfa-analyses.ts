// Narrowing registry. Narrowing dimensions are declared in the modules
// that own their identity / lattice / lift — this file only re-exports
// them and assembles the DEFAULT_NARROWINGS registry that the worklist
// and SVML JIT consume.

import { constAnalysis } from "../const-analysis/analysis";
import { typeAnalysis, typeNarrowing } from "../type-analysis/analysis";
import { paramConstNarrowing, paramTypeNarrowing } from "./param-handles";
import {
  returnKindNarrowing,
  typeRequirementAnalysis,
} from "../type-requirement-analysis/analysis";
import type { Narrowing } from "./analysis";
import {
  type FunctionId,
  type NodeId,
  type ParamKey,
} from "./key-spaces";

export {
  typeAnalysis,
  constAnalysis,
  typeNarrowing,
  paramTypeNarrowing,
  paramConstNarrowing,
  returnKindNarrowing,
  typeRequirementAnalysis,
};

/** Default narrowing set. Worklist callers that omit the constructor's
 *  `narrowings` parameter get this list.
 *
 *  **Policy: param-only runtime speculation.** Runtime observations extend
 *  AssumptionChains along the parameter axis (paramTypeNarrowing, sourced
 *  from runtimeParamChannel) and the callee-return-kind axis
 *  (returnKindNarrowing, which reduces back to param-type guards at entry
 *  via requirementAtEntry). Node-keyed dimensions (typeNarrowing /
 *  constNarrowing) exist as fact/static surfaces but are NOT registered
 *  for chain extension: they would blow up chain width by one node per
 *  observed write with no matching dispatch surface (entry guards are
 *  param-keyed). A future backend that wants mid-body speculation can opt
 *  in by passing a richer narrowings list to `new Worklist(...)`. */
export const DEFAULT_NARROWINGS: ReadonlyArray<Narrowing<any, unknown>> = [
  paramTypeNarrowing,
  returnKindNarrowing,
];
