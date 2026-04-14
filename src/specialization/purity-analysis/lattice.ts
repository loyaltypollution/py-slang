// Per-slot abstract value for the purity dataflow. Tracks the *origin* of the
// value held in each slot so that a subscript-store is pure iff it targets a
// freshly-allocated object that has not escaped this frame.
//
// Top-level lattice (flat above ⊥ with Unknown at top):
//
//             Unknown
//           /  /  \  \
//       Fresh Param Global Closure   (peers above Bottom)
//           \  \  /  /
//             Bottom
//
// `Fresh(origin)` carries the node id of the allocation site so joining two
// Fresh values from the *same* site stays Fresh; different sites widen to
// Unknown. `Param(slot)` likewise tags the param identity. Global needs no
// discriminant. Any cross-kind join widens to Unknown.
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
  // `purityScopePass`. `undefined` means "inner not yet analyzed" — treated
  // as pending at call sites (no tainting until the verdict lands), which
  // keeps the outer block's summary monotone under the cross-pass
  // dependency on `purityScopePass`. A Call through a slot holding a pure
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

export function fresh(origin: number): AbsVal {
  return { kind: "fresh", origin };
}

export function param(slot: number): AbsVal {
  return { kind: "param", slot };
}

export function closure(fdId: number, pure: boolean | undefined): AbsVal {
  return { kind: "closure", fdId, pure };
}

export function absEquals(a: AbsVal, b: AbsVal): boolean {
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
  // Impure marker lives only at the exprFacts sentinel key; incomparable
  // with every other kind. Guard before the `unknown` arm so a spurious
  // leq(IMPURE, UNKNOWN) === true can't suppress a change event.
  if (a.kind === "impure" || b.kind === "impure") {
    return a.kind === "impure" && b.kind === "impure";
  }
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
  if (a.kind === "impure" && b.kind === "impure") return a;
  if (a.kind === "impure" || b.kind === "impure") return UNKNOWN;
  if (a.kind === "unknown" || b.kind === "unknown") return UNKNOWN;
  // Closure sub-lattice: monotonically refine `undefined` → `defined`, so
  // the `pending → pure` transition from `purityScopePass` survives the
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

/** Is `v` a freshly-allocated value still owned by this frame? Caller-visible
 *  mutation is pure iff the target slot holds such a value. */
export function isFresh(v: AbsVal | undefined): boolean {
  return v !== undefined && v.kind === "fresh";
}
