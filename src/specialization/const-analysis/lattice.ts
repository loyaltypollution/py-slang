export type ConstValue = number | boolean | string;

// Constant-propagation lattice: BOTTOM ≤ const(v) ≤ TOP. Join of disagreeing
// constants is TOP. mergeKind = "may".
export type ConstLattice =
  | { readonly tag: "bottom" }
  | { readonly tag: "const"; readonly value: ConstValue }
  | { readonly tag: "top" };

export const CONST_BOTTOM: ConstLattice = Object.freeze({ tag: "bottom" as const });
export const CONST_TOP: ConstLattice = Object.freeze({ tag: "top" as const });
export function constOf(value: ConstValue): ConstLattice {
  return { tag: "const", value };
}

export function constLeq(a: ConstLattice, b: ConstLattice): boolean {
  if (a.tag === "bottom") return true;
  if (b.tag === "top") return true;
  if (a.tag === "top") return false;
  if (b.tag === "bottom") return false;
  return a.value === b.value;
}

export function constJoin(a: ConstLattice, b: ConstLattice): ConstLattice {
  if (a.tag === "bottom") return b;
  if (b.tag === "bottom") return a;
  if (a.tag === "top" || b.tag === "top") return CONST_TOP;
  return a.value === b.value ? a : CONST_TOP;
}

export function constMeet(a: ConstLattice, b: ConstLattice): ConstLattice {
  if (a.tag === "top") return b;
  if (b.tag === "top") return a;
  if (a.tag === "bottom" || b.tag === "bottom") return CONST_BOTTOM;
  return a.value === b.value ? a : CONST_BOTTOM;
}
