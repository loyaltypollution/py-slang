// Per-(Unit, AssumptionSet) forked function bodies.
//
// This is storage, not algebra. An assumption-set is a point in the
// meet-semilattice; a "body" is the Stmt[] a transform has rewritten for
// compilation at that point. The `(Unit, AssumptionSet) ⇀ Body` store is
// a presheaf shape: many points carry no rewrite, some ancestor did, and
// `visibleBody` is a nearest-ancestor lookup.
//
// Body ownership contract:
//   - `visibleBody(unit, s)` returns the array visible at `s`. Walks
//     `s → empty`; the nearest owning node wins. Under `empty` the
//     returned array IS `unit.funcAst.body` — the shared canonical AST.
//   - `forkBody(unit, s)` publishes a rewrite at `s`, cloning the
//     currently-visible body if there isn't one yet. Multiple rules
//     firing at the same `s` mutate the same forked array.
//   - Callers never insert forked nodes into topology/CFG/analysis
//     stores; those stores own the canonical AST.

import type { StmtNS } from "../../ast-types";
import { cloneStmts } from "./ast-deep-clone";
import type { AssumptionSet } from "./assumption-algebra";
import { leq } from "./assumption-algebra";
import type { Unit } from "./function-unit";

const bodies: WeakMap<Unit, Map<AssumptionSet, StmtNS.Stmt[]>> = new WeakMap();

function perUnit(unit: Unit): Map<AssumptionSet, StmtNS.Stmt[]> {
  let m = bodies.get(unit);
  if (m === undefined) {
    m = new Map();
    bodies.set(unit, m);
  }
  return m;
}

/** Body visible at `s`: the most-specific non-retired stored fork whose
 *  assumption-set is algebraically ⊑ `s`, or `unit.body` when none. The
 *  lookup is algebraic rather than parent-walk so a fork published at a
 *  subset chain still surfaces when `s` was built via the interner's
 *  rebuild path (different parent-pointer path, same algebraic
 *  superset).
 *
 *  "Most specific" = largest depth. If two stored forks are
 *  incomparable subsets of `s`, either can win; transforms publish at
 *  canonical witness chains so this edge case does not arise in
 *  practice.
 *
 *  When `isRetired` is supplied, any stored fork at a retired chain is
 *  skipped — lazy invalidation of stale forks. Callers that don't care
 *  about retirement (transform sweeps during drain, tests exercising
 *  pure body-storage semantics) omit the predicate. */
export function visibleBody(
  unit: Unit,
  s: AssumptionSet,
  isRetired?: (s: AssumptionSet) => boolean,
): readonly StmtNS.Stmt[] {
  if (s.parent === undefined) return unit.body;
  const m = bodies.get(unit);
  if (m === undefined) return unit.body;
  let best: AssumptionSet | undefined;
  for (const k of m.keys()) {
    if (!leq(k, s)) continue;
    if (isRetired !== undefined && isRetired(k)) continue;
    if (best === undefined || k.depth > best.depth) best = k;
  }
  return best !== undefined ? m.get(best)! : unit.body;
}

/** Materialize (or reuse) a forked body at `s`. Under `empty` returns
 *  `unit.body` (no fork — transforms may not mutate the canonical AST at
 *  `empty` through this path; that is enforced by caller convention). */
export function forkBody(unit: Unit, s: AssumptionSet): StmtNS.Stmt[] {
  if (s.parent === undefined) return unit.body;
  const m = perUnit(unit);
  const existing = m.get(s);
  if (existing !== undefined) return existing;
  const fork = cloneStmts(visibleBody(unit, s));
  m.set(s, fork);
  return fork;
}

/** Drop every forked body owned by `unit`. */
export function clearUnitBodies(unit: Unit): void {
  bodies.delete(unit);
}

/** Drop the forked body at `s` for `unit`, if any. No-op at `empty` or
 *  when `s` has no fork. Returns true iff a fork was dropped. */
export function evictAt(unit: Unit, s: AssumptionSet): boolean {
  if (s.parent === undefined) return false;
  const m = bodies.get(unit);
  if (m === undefined) return false;
  return m.delete(s);
}
