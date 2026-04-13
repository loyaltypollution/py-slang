// src/specialization/purity-analysis/lattice.ts
//
// Flat two-valued lattice for the purity effect analysis.
// pure ⊏ impure; join widens toward impure (may-analysis).

export type PureEffect = "pure" | "impure";

export const PURE: PureEffect = "pure";
export const IMPURE: PureEffect = "impure";

/** Hint field written by the expression-level analysis. */
export const PURE_EFFECT_FIELD = "pureEffect";

/** Hint field written by the scope-level summary fold. */
export const PURE_FIELD = "pure";

export function joinEffect(a: PureEffect, b: PureEffect): PureEffect {
  return a === IMPURE || b === IMPURE ? IMPURE : PURE;
}

export function meetEffect(a: PureEffect, b: PureEffect): PureEffect {
  return a === PURE || b === PURE ? PURE : IMPURE;
}

export function leqEffect(a: PureEffect, b: PureEffect): boolean {
  return a === b || a === PURE;
}
