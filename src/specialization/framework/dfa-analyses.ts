// Narrowing registry. Narrowing dimensions are declared in the modules
// that own their identity/lattice/lift — this file re-exports them and
// assembles DEFAULT_NARROWINGS for worklist and SVML JIT consumers.

import { constAnalysis } from "../const-analysis/analysis";
import { typeAnalysis, typeNarrowing } from "../type-analysis/analysis";
import { paramConstNarrowing, paramTypeNarrowing } from "./param-handles";
import {
  returnKindNarrowing,
  typeRequirementAnalysis,
} from "../type-requirement-analysis/analysis";
import type { Narrowing } from "./analysis";

export {
  typeAnalysis,
  constAnalysis,
  typeNarrowing,
  paramTypeNarrowing,
  paramConstNarrowing,
  returnKindNarrowing,
  typeRequirementAnalysis,
};

/** Default narrowing set. Policy: param-only runtime speculation — chain
 *  extension happens along the parameter axis (paramTypeNarrowing) and the
 *  callee-return-kind axis (returnKindNarrowing, reduced back to param-type
 *  guards at entry via requirementAtEntry). Node-keyed dimensions exist as
 *  fact surfaces but are not registered for chain extension. */
export const DEFAULT_NARROWINGS: ReadonlyArray<Narrowing<any, unknown>> = [
  paramTypeNarrowing,
  returnKindNarrowing,
];
