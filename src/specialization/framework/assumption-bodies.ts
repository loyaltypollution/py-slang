// Per-(Unit, Speculation) forked function bodies. Storage only.
// `visibleBody` finds the deepest non-refuted stored fork ⊑ s, falling
// back to `unit.body`. `forkBody` publishes a rewrite at `s`.

import type { StmtNS } from "../../ast-types";
import { cloneStmts } from "./ast-deep-clone";
import type { Speculation } from "./assumption-algebra";
import { leq } from "./assumption-algebra";
import type { Unit } from "./function-unit";

const bodies: WeakMap<Unit, Map<Speculation, StmtNS.Stmt[]>> = new WeakMap();

function perUnit(unit: Unit): Map<Speculation, StmtNS.Stmt[]> {
  let m = bodies.get(unit);
  if (m === undefined) {
    m = new Map();
    bodies.set(unit, m);
  }
  return m;
}

/** Body visible at `s`: deepest non-refuted stored fork ⊑ `s`, else
 *  `unit.body`. */
export function visibleBody(
  unit: Unit,
  s: Speculation,
  isRefuted?: (s: Speculation) => boolean,
): readonly StmtNS.Stmt[] {
  if (s.parent === undefined) return unit.body;
  const m = bodies.get(unit);
  if (m === undefined) return unit.body;
  let best: Speculation | undefined;
  for (const k of m.keys()) {
    if (!leq(k, s)) continue;
    if (isRefuted !== undefined && isRefuted(k)) continue;
    if (best === undefined || k.depth > best.depth) best = k;
  }
  return best !== undefined ? m.get(best)! : unit.body;
}

/** Materialize (or reuse) a forked body at `s`. Returns `unit.body` at `empty`. */
export function forkBody(unit: Unit, s: Speculation): StmtNS.Stmt[] {
  if (s.parent === undefined) return unit.body;
  const m = perUnit(unit);
  const existing = m.get(s);
  if (existing !== undefined) return existing;
  const fork = cloneStmts(visibleBody(unit, s));
  m.set(s, fork);
  return fork;
}
