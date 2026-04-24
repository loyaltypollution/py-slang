// Narrowing registry. Narrowing dimensions are declared in the modules
// that own their identity/lattice/lift — this file re-exports the block
// analyses consumed by transforms and assembles DEFAULT_NARROWINGS for
// worklist and SVML JIT consumers.

import { constAnalysis, returnKindNarrowing, typeAnalysis } from "./analysis";
import { paramTypeNarrowing } from "./narrowing-policy/param-handles";
import type { Narrowing } from "./framework/analysis";

export { typeAnalysis, constAnalysis };

/** Default narrowing set. Policy: param-only runtime speculation — chain
 *  extension happens along the parameter axis (paramTypeNarrowing) and the
 *  callee-return-kind axis (returnKindNarrowing, reduced back to param-type
 *  guards at entry via requirementAtEntry). Node-keyed dimensions exist as
 *  fact surfaces but are not registered for chain extension. */
export const DEFAULT_NARROWINGS: ReadonlyArray<Narrowing<any, unknown>> = [
  paramTypeNarrowing,
  returnKindNarrowing,
];
