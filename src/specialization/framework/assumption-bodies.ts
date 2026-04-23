// Per-(Unit, AssumptionChain) forked function bodies. Storage only.
// `visibleBody` finds the deepest non-refuted stored fork ⊑ s, falling
// back to `unit.body`. `forkBody` publishes a rewrite at `s`.

import type { StmtNS } from "../../ast-types";
import { cloneStmts } from "./ast-deep-clone";
import type { AssumptionChain } from "../lattice/algebra";
import { leq } from "../lattice/algebra";
import type { Unit } from "./function-unit";

const bodies: WeakMap<Unit, Map<AssumptionChain, StmtNS.Stmt[]>> = new WeakMap();

/** Body visible at `s`: deepest non-refuted stored fork ⊑ `s`, else
 *  `unit.body`. */
export function visibleBody(
  unit: Unit,
  s: AssumptionChain,
  isRefuted?: (s: AssumptionChain) => boolean,
): readonly StmtNS.Stmt[] {
  if (s.parent === undefined) return unit.body;
  const m = bodies.get(unit);
  if (m === undefined) return unit.body;
  let best: AssumptionChain | undefined;
  for (const k of m.keys()) {
    if (!leq(k, s)) continue;
    if (isRefuted !== undefined && isRefuted(k)) continue;
    if (best === undefined || k.depth > best.depth) best = k;
  }
  return best !== undefined ? m.get(best)! : unit.body;
}

/** Materialize (or reuse) a forked body at `s`. Returns `unit.body` at `empty`. */
export function forkBody(unit: Unit, s: AssumptionChain): StmtNS.Stmt[] {
  if (s.parent === undefined) return unit.body;
  let m = bodies.get(unit);
  if (m === undefined) {
    m = new Map();
    bodies.set(unit, m);
  }
  const existing = m.get(s);
  if (existing !== undefined) return existing;
  const fork = cloneStmts(visibleBody(unit, s));
  m.set(s, fork);
  return fork;
}
