import { isRoot, type AssumptionChain } from "../assumption/chain";
import type { TransformResult } from "../framework/analysis";
import type { Function } from "../program/function/function";
import { forkBody, invalidateDescendantVariants } from "../speculation/assumption-bodies";
import type { StmtNS } from "../../ast-types";

export function transformResultFor(touchedWitnesses: readonly AssumptionChain[]): TransformResult {
  return {
    changed: touchedWitnesses.length > 0,
    canonicalChanged: touchedWitnesses.some(isRoot),
    touchedWitnesses,
  };
}

/** Apply per-witness plans depth-ascending. Forks each witness's body and
 *  invokes `apply`; if it reports a change, the witness is recorded as touched
 *  and its descendant variants are invalidated. Depth order matters: a forked
 *  body is cloned from its parent's, so shallower writes must land first. */
export function runPerWitness<P>(
  unit: Function,
  plansByWitness: ReadonlyMap<AssumptionChain, P>,
  apply: (body: StmtNS.Stmt[], plans: P) => boolean,
): TransformResult {
  const ordered = Array.from(plansByWitness.keys()).sort((a, b) => a.depth - b.depth);
  const touched: AssumptionChain[] = [];
  for (const witness of ordered) {
    const body = forkBody(unit, witness);
    if (apply(body, plansByWitness.get(witness)!)) {
      touched.push(witness);
      invalidateDescendantVariants(unit, witness);
    }
  }
  return transformResultFor(touched);
}

/** Group `(id → {witness, replacement})` plans into `witness → (id → replacement)`. */
export function groupPlansByWitness<T>(
  plans: Iterable<readonly [number, { witness: AssumptionChain; replacement: T }]>,
): Map<AssumptionChain, Map<number, T>> {
  const out = new Map<AssumptionChain, Map<number, T>>();
  for (const [id, plan] of plans) {
    let bucket = out.get(plan.witness);
    if (bucket === undefined) {
      bucket = new Map();
      out.set(plan.witness, bucket);
    }
    bucket.set(id, plan.replacement);
  }
  return out;
}
