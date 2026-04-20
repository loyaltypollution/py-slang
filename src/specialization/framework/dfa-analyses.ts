// Narrowing registry. Narrowing dimensions are declared in the modules
// that own their identity / lattice / lift — this file only re-exports
// them and assembles the DEFAULT_NARROWINGS / JIT_RELEVANT_NARROWINGS
// registries that the worklist and SVML JIT consume.

import { constAnalysis, constNarrowing } from "../const-analysis/analysis";
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
  constNarrowing,
  paramTypeNarrowing,
  paramConstNarrowing,
  returnKindNarrowing,
  typeRequirementAnalysis,
};

/** Default narrowing set. Worklist callers that omit the constructor's
 *  `narrowings` parameter get this list.
 *
 *  The return-kind dimension is keyed in a different space (functionId, sourced
 *  from `runtimeReturnAnalysis`) than the node-keyed type/const dimensions
 *  (sourced from `runtimeWriteAnalysis`). The observation translator
 *  filters on `observationSource` so they never cross-trigger. */
export const DEFAULT_NARROWINGS: ReadonlyArray<Narrowing<NodeId | FunctionId | ParamKey, unknown>> = [
  paramTypeNarrowing,
  paramConstNarrowing,
  typeNarrowing,
  constNarrowing,
  returnKindNarrowing,
];

/** Narrowings that currently affect SVML code generation. Write-driven type
 *  narrowings remain available in speculation contexts and lineage pruning,
 *  but the backend does not consume speculative type facts directly, so the
 *  JIT should not treat them as artifact-shaping inputs. */
export const JIT_RELEVANT_NARROWINGS: ReadonlyArray<Narrowing<NodeId | FunctionId | ParamKey, unknown>> = [
  paramTypeNarrowing,
  paramConstNarrowing,
  constNarrowing,
  returnKindNarrowing,
];
