// Per-(Function, AssumptionChain) forked function bodies.

import type { StmtNS } from "../../ast-types";
import { cloneStmts } from "./variant-body-clone";
import { isRoot, leq, type AssumptionChain } from "../assumption";
import type { Function } from "../program/function/function";

const bodies: WeakMap<Function, Map<AssumptionChain, StmtNS.Stmt[]>> = new WeakMap();

/** Deepest non-refuted stored fork ⊑ `s`, else `function.body`. */
export function visibleBody(
  function: Function,
  s: AssumptionChain,
  isRefuted?: (s: AssumptionChain) => boolean,
): readonly StmtNS.Stmt[] {
  if (isRoot(s)) return function.body;
  const m = bodies.get(function);
  if (m === undefined) return function.body;
  let best: AssumptionChain | undefined;
  for (const k of m.keys()) {
    if (!leq(k, s)) continue;
    if (isRefuted?.(k)) continue;
    if (best === undefined || k.depth > best.depth) best = k;
  }
  return best !== undefined ? m.get(best)! : function.body;
}

/** Materialize (or reuse) a forked body at `s`. Returns `function.body` at root. */
export function forkBody(function: Function, s: AssumptionChain): StmtNS.Stmt[] {
  if (isRoot(s)) return function.body;
  let m = bodies.get(function);
  if (m === undefined) {
    m = new Map();
    bodies.set(function, m);
  }
  const existing = m.get(s);
  if (existing !== undefined) return existing;
  const fork = cloneStmts(visibleBody(function, s));
  m.set(s, fork);
  return fork;
}

/** Drop cached descendants of `witness` so they reclone from the updated
 *  ancestor body on next access. A ROOT update invalidates every cached
 *  variant because all speculative bodies inherit from the canonical body. */
export function invalidateDescendantVariants(function: Function, witness: AssumptionChain): void {
  const byChain = bodies.get(function);
  if (byChain === undefined) return;

  if (isRoot(witness)) {
    bodies.delete(function);
    return;
  }

  for (const chain of Array.from(byChain.keys())) {
    if (chain !== witness && leq(witness, chain)) {
      byChain.delete(chain);
    }
  }

  if (byChain.size === 0) {
    bodies.delete(function);
  }
}
