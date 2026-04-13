// src/specialization/index.ts — public API barrel

// ── FunctionUnit (per-scope structural grouping) ───────────────────────────

export type { FunctionUnit } from "./framework/function-unit";
export { buildFunctionUnits } from "./framework/function-unit";

// ── Type lattice (codegen reads kind bits + refinements from hints) ──────────

export type { TypeLattice } from "./type-analysis/lattice";
export {
  INT_BIT,
  BOOL_BIT,
  STR_BIT,
  NULL_BIT,
  CLOSURE_BIT,
  FLOAT_BIT,
  COMPLEX_BIT,
  IntRef,
  BoolRef,
  join,
  meet,
  leq,
  TOP,
  BOTTOM,
  integer,
  positiveInteger,
  negativeInteger,
  zeroInteger,
  boolean,
  trueValue,
  falseValue,
  floatValue,
  positiveFloat,
  negativeFloat,
  zeroFloat,
  complexValue,
  stringValue,
  nullValue,
  closureValue,
} from "./type-analysis/lattice";

// ── Const lattice ────────────────────────────────────────────────────────────

export { constLeq, constJoin, constMeet } from "./const-analysis/analysis";
export type { ConstLattice, ConstValue } from "./const-analysis/lattice";
export { CONST_BOTTOM, CONST_TOP, constOf } from "./const-analysis/lattice";

// ── Memoization runtime helpers ──────────────────────────────────────────────

export { MEMOIZATION_THRESHOLD } from "./memoization-analysis/call-count";
export { PURE_FIELD } from "./purity-analysis/lattice";
export { memoLookup, memoPut, clearMemoCache, memoCacheSnapshot, MEMO_MISS } from "../runtime/memo";
