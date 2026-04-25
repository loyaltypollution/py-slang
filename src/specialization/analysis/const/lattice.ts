// Constant-propagation lattice: BOTTOM ≤ const(v) ≤ TOP. Join of disagreeing
// constants is TOP.
import type { Lattice } from "../../framework/analysis";

export type ConstLattice =
  | { readonly tag: "bottom" }
  | { readonly tag: "const"; readonly value: number }
  | { readonly tag: "top" };

export const CONST_BOTTOM: ConstLattice = Object.freeze({ tag: "bottom" as const });
export const CONST_TOP: ConstLattice = Object.freeze({ tag: "top" as const });

export function constOf(value: number): ConstLattice {
  return { tag: "const", value };
}

export function constJoin(a: ConstLattice, b: ConstLattice): ConstLattice {
  if (a.tag === "bottom") return b;
  if (b.tag === "bottom") return a;
  if (a.tag === "top" || b.tag === "top") return CONST_TOP;
  return a.value === b.value ? a : CONST_TOP;
}

export function constLeq(a: ConstLattice, b: ConstLattice): boolean {
  if (a.tag === "bottom") return true;
  if (b.tag === "top") return true;
  if (a.tag === "top") return false;
  if (b.tag === "bottom") return false;
  return a.value === b.value;
}

export function constEq(a: ConstLattice, b: ConstLattice): boolean {
  if (a === b) return true;
  if (a.tag !== b.tag) return false;
  if (a.tag === "const" && b.tag === "const") return a.value === b.value;
  return true;
}

export function constMeet(a: ConstLattice, b: ConstLattice): ConstLattice {
  if (a.tag === "top") return b;
  if (b.tag === "top") return a;
  if (a.tag === "bottom" || b.tag === "bottom") return CONST_BOTTOM;
  return a.value === b.value ? a : CONST_BOTTOM;
}

export const constLattice: Lattice<ConstLattice> = {
  bottom: CONST_BOTTOM,
  top: CONST_TOP,
  join: constJoin,
  meet: constMeet,
  leq: constLeq,
  eq: constEq,
};
