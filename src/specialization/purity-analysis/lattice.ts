// Per-slot abstract value for the purity dataflow. Tracks the *origin* of the
// value held in each slot so that a subscript-store is pure iff it targets a
// freshly-allocated object that has not escaped this frame.
//
// The lattice is flat above ⊥ with one top element (Unknown):
//
//             Unknown
//           /    |    \
//       Fresh  Param  Global   (peers; all above Bottom)
//           \    |    /
//             Bottom
//
// `Fresh(origin)` carries the node id of the allocation site so joining two
// Fresh values from the *same* site stays Fresh; different sites widen to
// Unknown. `Param(slot)` likewise tags the param identity. Global needs no
// discriminant. Any cross-kind join widens to Unknown.

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
  | { readonly kind: "unknown" };

export const BOTTOM: AbsVal = Object.freeze({ kind: "bottom" });
export const UNKNOWN: AbsVal = Object.freeze({ kind: "unknown" });
export const GLOBAL: AbsVal = Object.freeze({ kind: "global" });

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
  if (b.kind === "unknown") return true;
  return absEquals(a, b);
}

export function absJoin(a: AbsVal, b: AbsVal): AbsVal {
  if (a.kind === "bottom") return b;
  if (b.kind === "bottom") return a;
  if (a.kind === "unknown" || b.kind === "unknown") return UNKNOWN;
  if (absEquals(a, b)) return a;
  return UNKNOWN;
}

/** Is `v` a freshly-allocated value still owned by this frame? Caller-visible
 *  mutation is pure iff the target slot holds such a value. */
export function isFresh(v: AbsVal | undefined): boolean {
  return v !== undefined && v.kind === "fresh";
}

// Block-global sticky summary. Monotone OR on join: once any path through the
// function has an observable side effect, the function is impure.
export interface PurityBlockSummary {
  readonly impure: boolean;
}

export const PURE_SUMMARY: PurityBlockSummary = Object.freeze({ impure: false });
export const IMPURE_SUMMARY: PurityBlockSummary = Object.freeze({ impure: true });

export function summaryJoin(
  a: PurityBlockSummary,
  b: PurityBlockSummary,
): PurityBlockSummary {
  if (a.impure || b.impure) return IMPURE_SUMMARY;
  return PURE_SUMMARY;
}

export function summaryEquals(
  a: PurityBlockSummary,
  b: PurityBlockSummary,
): boolean {
  return a.impure === b.impure;
}
