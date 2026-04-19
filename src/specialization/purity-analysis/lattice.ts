// Per-slot abstract value for the purity dataflow. Tracks the *origin* of the
// value held in each slot so that a subscript-store is pure iff it targets a
// freshly-allocated object that has not escaped this frame.
//
// Lattice shape (flat above ⊥, Unknown mid-level, Impure at top):
//
//                Impure
//                  |
//                Unknown
//             /  /  \  \
//         Fresh Param Global Closure   (peers above Bottom)
//             \  \  /  /
//                Bottom
//
// `Fresh(origin)` carries the node id of the allocation site so joining two
// Fresh values from the *same* site stays Fresh; different sites widen to
// Unknown. `Param(slot)` likewise tags the param identity. Global needs no
// discriminant. Any cross-kind join widens to Unknown.
//
// Impure is the lattice top. It lives only at `IMPURE_SENTINEL_NODE_ID` in the
// block fact's `exprFacts` map (never in a slot), so its interaction with the
// slot-valued Fresh/Param/etc. is purely hypothetical — but making it top
// keeps the lattice identities (`leq ⇔ join=b`) honest, so any future write
// of Impure at any key preserves its meaning across joins instead of being
// silently downgraded to Unknown.
//
// Closure carries a sub-lattice on its `pure` field so that refinement from
// "inner not yet analyzed" to a definite verdict propagates monotonically:
//
//     Closure(fd, true)       Closure(fd, false)
//            \                        /
//             Closure(fd, undefined)          (pending, bottom of sub-lattice)
//
// Same `fdId`, `undefined` ⊑ `true|false`; `true` vs `false` at same fdId
// widens to Unknown (contested); different `fdId` widens to Unknown.

export type AbsVal =
  | { readonly kind: "bottom" }
  | { readonly kind: "fresh"; readonly origin: number }
  | { readonly kind: "param"; readonly slot: number }
  | { readonly kind: "global" }
  // Closure value produced by a nested FunctionDef. `fdId` identifies the
  // nested function; `pure` records whether its body was determined pure by
  // `purityScopeAnalysis`. `undefined` means "inner not yet analyzed" — treated
  // as pending at call sites (no tainting until the verdict lands), which
  // keeps the outer block's summary monotone under the cross-analysis
  // dependency on `purityScopeAnalysis`. A Call through a slot holding a pure
  // Closure is pure; an impure Closure taints the enclosing function.
  | {
      readonly kind: "closure";
      readonly fdId: number;
      readonly pure: boolean | undefined;
    }
  // Block-global "impure" marker. Never stored in a slot; stashed in the
  // block fact's `exprFacts` at sentinel key `IMPURE_SENTINEL_NODE_ID` so the
  // DFA factory's per-key lattice join propagates it monotonically. Consumers
  // aggregate via `exprFacts.has(IMPURE_SENTINEL_NODE_ID)`.
  | { readonly kind: "impure" }
  | { readonly kind: "unknown" };

export const BOTTOM: AbsVal = Object.freeze({ kind: "bottom" });
export const UNKNOWN: AbsVal = Object.freeze({ kind: "unknown" });
export const GLOBAL: AbsVal = Object.freeze({ kind: "global" });
export const IMPURE_MARKER: AbsVal = Object.freeze({ kind: "impure" });

/** Reserved `exprFacts` key where the per-block impure marker lives. Negative
 *  so it can never collide with a real AST nodeId. */
export const IMPURE_SENTINEL_NODE_ID = -1;

function absEquals(a: AbsVal, b: AbsVal): boolean {
  if (a === b) return true;
  if (a.kind !== b.kind) return false;
  if (a.kind === "fresh" && b.kind === "fresh") return a.origin === b.origin;
  if (a.kind === "param" && b.kind === "param") return a.slot === b.slot;
  if (a.kind === "closure" && b.kind === "closure") {
    return a.fdId === b.fdId && a.pure === b.pure;
  }
  return true;
}

export function absLeq(a: AbsVal, b: AbsVal): boolean {
  if (a.kind === "bottom") return true;
  // Impure is the lattice top: every element is ⊑ Impure, and Impure is ⊑
  // only itself. Ordered so `leq ⇔ join=b` holds unconditionally.
  if (b.kind === "impure") return true;
  if (a.kind === "impure") return false;
  if (b.kind === "unknown") return true;
  // Closure sub-lattice: same-fdId `undefined` is below `defined`; defined
  // peers (true vs false) are incomparable. Different fdIds fall through.
  if (a.kind === "closure" && b.kind === "closure" && a.fdId === b.fdId) {
    if (a.pure === b.pure) return true;
    return a.pure === undefined;
  }
  return absEquals(a, b);
}

export function absJoin(a: AbsVal, b: AbsVal): AbsVal {
  if (a.kind === "bottom") return b;
  if (b.kind === "bottom") return a;
  // Impure is top: joining with it stays Impure.
  if (a.kind === "impure" || b.kind === "impure") return IMPURE_MARKER;
  if (a.kind === "unknown" || b.kind === "unknown") return UNKNOWN;
  // Closure sub-lattice: monotonically refine `undefined` → `defined`, so
  // the `pending → pure` transition from `purityScopeAnalysis` survives the
  // fact-store's monotone join. `true` vs `false` at the same fdId is a
  // genuine contestation → Unknown. Different fdIds → Unknown.
  if (a.kind === "closure" && b.kind === "closure" && a.fdId === b.fdId) {
    if (a.pure === b.pure) return a;
    if (a.pure === undefined) return b;
    if (b.pure === undefined) return a;
    return UNKNOWN;
  }
  if (absEquals(a, b)) return a;
  return UNKNOWN;
}

