// Canonical entry points. Non-analysis layers import from here; files inside
// analysis/ keep direct sibling imports to avoid cycles through this barrel.

export { constAnalysis } from "./const/analysis";
export { type ConstLattice } from "./const/lattice";

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
  requirementAtEntry,
  type EntryRequirement,
} from "./type-requirement/analysis";

export { purityBlockAnalysis, purityFunctionAnalysis } from "./purity/analysis";
export { livenessAnalysis, perStatementLiveOut } from "./liveness/analysis";
export { definitelyBoundAnalysis } from "./definitely-bound/analysis";
