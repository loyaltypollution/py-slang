// Per-(Function, AssumptionChain) forked function bodies.

import type { StmtNS } from "../../ast-types";
import { cloneStmts } from "./variant-body-clone";
import { isRoot, leq, type AssumptionChain } from "../assumption";
import type { Function } from "../program/function/function";

const bodies: WeakMap<Function, Map<AssumptionChain, StmtNS.Stmt[]>> = new WeakMap();

/** Deepest non-refuted stored fork ⊑ `s`, else `unit.body`. */
export function visibleBody(
  unit: Function,
  s: AssumptionChain,
  isRefuted?: (s: AssumptionChain) => boolean,
): readonly StmtNS.Stmt[] {
  if (isRoot(s)) return unit.body;
  const m = bodies.get(unit);
  if (m === undefined) return unit.body;
  let best: AssumptionChain | undefined;
  for (const k of m.keys()) {
    if (!leq(k, s)) continue;
    if (isRefuted?.(k)) continue;
    if (best === undefined || k.depth > best.depth) best = k;
  }
  return best !== undefined ? m.get(best)! : unit.body;
}

/** Materialize (or reuse) a forked body at `s`. Returns `unit.body` at root. */
export function forkBody(unit: Function, s: AssumptionChain): StmtNS.Stmt[] {
  if (isRoot(s)) return unit.body;
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

/** Drop cached descendants of `witness` so they reclone from the updated
 *  ancestor body on next access. A ROOT update invalidates every cached
 *  variant because all speculative bodies inherit from the canonical body. */
export function invalidateDescendantVariants(unit: Function, witness: AssumptionChain): void {
  const byChain = bodies.get(unit);
  if (byChain === undefined) return;

  if (isRoot(witness)) {
    bodies.delete(unit);
    return;
  }

  for (const chain of Array.from(byChain.keys())) {
    if (chain !== witness && leq(witness, chain)) {
      byChain.delete(chain);
    }
  }

  if (byChain.size === 0) {
    bodies.delete(unit);
  }
}
