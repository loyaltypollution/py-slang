// ── ConstLattice ──────────────────────────────────────────────────────────────

export type ConstValue = number | boolean | string;

/**
 * Constant-propagation lattice element.
 *
 * Ordering: BOTTOM ≤ const(v) ≤ TOP
 *   - bottom  = "no info yet" — identity for join
 *   - const(v) = "definitely has value v on all paths so far"
 *   - top     = "overdefined / unknown"
 *
 * join(const(v), const(w)) = top when v ≠ w (paths disagree → lose the constant).
 * mergeKind = "may" so the existing DFAStatementDriver works unchanged.
 */
export type ConstLattice =
  | { readonly tag: "bottom" }
  | { readonly tag: "const"; readonly value: ConstValue }
  | { readonly tag: "top" };

export const CONST_BOTTOM: ConstLattice = Object.freeze({ tag: "bottom" as const });
export const CONST_TOP: ConstLattice = Object.freeze({ tag: "top" as const });
export function constOf(value: ConstValue): ConstLattice {
  return { tag: "const", value };
}

// ── Lattice operations ────────────────────────────────────────────────────────

export function constLeq(a: ConstLattice, b: ConstLattice): boolean {
  if (a.tag === "bottom") return true;
  if (b.tag === "top") return true;
  if (a.tag === "top") return false; // top ≤ b only if b === top (handled above)
  if (b.tag === "bottom") return false;
  return a.value === b.value; // const(v) ≤ const(w) iff v === w
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
