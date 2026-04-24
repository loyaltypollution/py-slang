import type { JoinSemiLattice } from "../../framework/analysis";

// Per-slot abstract value for the purity dataflow. Tracks origin so a
// subscript-store is pure iff it targets a fresh (non-escaped) container.
//
//                Impure
//                  |
//                Unknown
//             /  /  \  \
//         Fresh Param Global Closure   (peers above Bottom)
//             \  \  /  /
//                Bottom
//
// Fresh(origin) — same allocation site joins stay Fresh.
// Param(slot)   — tagged by param identity.
// Closure(fid, pure) sub-lattice: Closure(fid, undef) ⊑ Closure(fid, true|false);
// true vs false at same fid → Unknown. Different fid → Unknown.
// Impure is top; lives only at IMPURE_SENTINEL_NODE_ID in `exprFacts`, never
// in a slot. Making it top keeps `leq ⇔ join=b` honest.

export type AbsVal =
  | { readonly kind: "bottom" }
  | { readonly kind: "fresh"; readonly origin: number }
  | { readonly kind: "param"; readonly slot: number }
  | { readonly kind: "global" }
  // `pure === undefined` means inner not yet analyzed: pending at call sites
  // (monotone-safe — no tainting until the verdict lands).
  | {
      readonly kind: "closure";
      readonly functionId: number;
      readonly pure: boolean | undefined;
    }
  | { readonly kind: "impure" }
  | { readonly kind: "unknown" };

export const BOTTOM: AbsVal = Object.freeze({ kind: "bottom" });
export const UNKNOWN: AbsVal = Object.freeze({ kind: "unknown" });
export const GLOBAL: AbsVal = Object.freeze({ kind: "global" });
export const IMPURE_MARKER: AbsVal = Object.freeze({ kind: "impure" });

/** Reserved `exprFacts` key for the block impure marker. Negative so it
 *  cannot collide with an AST nodeId. */
export const IMPURE_SENTINEL_NODE_ID = -1;

function absEquals(a: AbsVal, b: AbsVal): boolean {
  if (a === b) return true;
  if (a.kind !== b.kind) return false;
  switch (a.kind) {
    case "fresh":
      return a.origin === (b as typeof a).origin;
    case "param":
      return a.slot === (b as typeof a).slot;
    case "closure": {
      const c = b as typeof a;
      return a.functionId === c.functionId && a.pure === c.pure;
    }
    default:
      return true;
  }
}

export function absLeq(a: AbsVal, b: AbsVal): boolean {
  if (a.kind === "bottom") return true;
  if (b.kind === "impure") return true;
  if (a.kind === "impure") return false;
  if (b.kind === "unknown") return true;
  if (a.kind === "closure" && b.kind === "closure" && a.functionId === b.functionId) {
    if (a.pure === b.pure) return true;
    return a.pure === undefined;
  }
  return absEquals(a, b);
}

export function absJoin(a: AbsVal, b: AbsVal): AbsVal {
  if (a.kind === "bottom") return b;
  if (b.kind === "bottom") return a;
  if (a.kind === "impure" || b.kind === "impure") return IMPURE_MARKER;
  if (a.kind === "unknown" || b.kind === "unknown") return UNKNOWN;
  if (a.kind === "closure" && b.kind === "closure" && a.functionId === b.functionId) {
    if (a.pure === b.pure) return a;
    if (a.pure === undefined) return b;
    if (b.pure === undefined) return a;
    return UNKNOWN;
  }
  if (absEquals(a, b)) return a;
  return UNKNOWN;
}

/** Join-semilattice only — no natural meet/top, pair with `mergeKind: "may"`. */
export const absValLattice: JoinSemiLattice<AbsVal> = {
  bottom: BOTTOM,
  leq: absLeq,
  join: absJoin,
  eq: (a, b) => a === b || (absLeq(a, b) && absLeq(b, a)),
};
