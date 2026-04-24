// Per-analysis canonical entry points. Other layers (transforms, narrowings,
// defaults, dfa-query, narrowing-policy hooks) import from here so that
// adding a new analysis means touching one path, not many.
//
// Files INSIDE analysis/ keep direct relative imports to siblings — going
// through this index would create paper cycles even though the underlying
// edges are downward-only.

export { constAnalysis } from "./const/analysis";
export { constEq, type ConstLattice } from "./const/lattice";

export { typeAnalysis, typeNarrowing, liftType } from "./type/analysis";
export {
  eq as typeEq,
  BOOL_BIT,
  BoolRef,
  INT_BIT,
  IntRef,
  type TypeLattice,
} from "./type/lattice";
export { truthiness } from "./type/transfer";

export {
  typeRequirementAnalysis,
  returnKindNarrowing,
  returnKindBinding,
  requirementAtEntry,
  type EntryRequirement,
} from "./type-requirement/analysis";

export { purityBlockAnalysis, purityScopeAnalysis } from "./purity/analysis";
export { livenessAnalysis, perStatementLiveOut } from "./liveness/analysis";
export { definitelyBoundAnalysis } from "./definitely-bound/analysis";
