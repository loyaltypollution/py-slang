// Helper for unit-keyed transform rules. The worklist sweeps each rule's
// dirty set after analyses converge; rules that rewrote return `true` to
// schedule a CFG rebuild. Idempotency across rebuilds is the caller's
// concern — the rewrite must make its own precondition fail (dead-branch
// removes the branch; const-fold replaces the variable; memoization detects
// its own prelude). Rules that cannot become precondition-false on their own
// should not be expressed as sweep-transforms.

import { ROOT_CONTEXT, hasAncestor, type AssumptionChain } from "./context";
import type { FactEdge, Reading, TransformRule, TransformFactView } from "./analysis";
import { readExprFact } from "./dfa-factory";
import type { Unit } from "./function-unit";
import type { ProgramTopology } from "./topology";
import { forkBodyAt } from "./chain-body-store";

export type { Reading, TransformFactView };

function readMinimalExact<V>(
  from: AssumptionChain,
  readAtContext: (context: AssumptionChain) => V | undefined,
  accept: (value: V) => boolean,
): Reading<V> | undefined {
  let match: Reading<V> | undefined;
  for (let cur: AssumptionChain | undefined = from; cur !== undefined; cur = cur.parent) {
    const value = readAtContext(cur);
    if (value === undefined || !accept(value)) continue;
    match = { value, witness: cur };
  }
  return match;
}

/** Construct a `TransformFactView` bound to one semantic read context.
 *  Canonical worklist sweeps use ROOT. Speculative clone consumers may bind a
 *  non-ROOT context for semantic reads while still sourcing profitability
 *  counters from ROOT. */
export function transformFacts(
  topology: ProgramTopology,
  context: AssumptionChain,
  profitabilityContext: AssumptionChain = ROOT_CONTEXT,
): TransformFactView {
  return {
    readAt: (analysis, key) => ({ value: analysis.store.read(key, context), witness: context }),
    readMinimal: (analysis, key, accept) =>
      readMinimalExact(context, ctx => analysis.store.tryRead(key, ctx), accept),
    readExprFactAt: (analysis, nodeId) => {
      const value = readExprFact(topology, analysis, nodeId, context);
      return value === undefined ? undefined : { value, witness: context };
    },
    readExprFactMinimal: (analysis, nodeId, accept) =>
      readMinimalExact(context, ctx => readExprFact(topology, analysis, nodeId, ctx), accept),
    readProfitability: (analysis, key) => analysis.store.read(key, profitabilityContext),
    bodyAtWitness: (unit, reading) => {
      // Fork always happens at the view's bound context — that is where the
      // rule is authorized to publish. `reading.witness` is retained as a
      // justification channel (memoization reads it to derive the memo
      // variant key for sibling cache-convergence) but does NOT relocate
      // the fork. Forking at per-read witnesses would make rules at the
      // same view-context stomp different locations of the chain;
      // composing multiple rules at one context would fragment the AST.
      //
      // The witness must still be an ancestor (or equal) of the view's
      // bound context — a Reading<V> produced by readMinimal / readAt can
      // only name a witness on the walk from bound context toward ROOT.
      // This check rejects hand-forged Readings (synthetic tests that
      // construct one directly); normal paths can't trip it.
      if (!hasAncestor(context, reading.witness)) {
        throw new Error(
          `[bodyAtWitness] witness is not an ancestor of the view's bound context — ` +
            `a Reading from a different view cannot be used to rewrite here`,
        );
      }
      return forkBodyAt(unit, context);
    },
  };
}

/** Build a unit-keyed transform rule from a sweep function that reads
 *  fact state and publishes via `facts.bodyAtWitness(...)`. Returns `true`
 *  iff the body was rewritten. `edges` declares upstream analyses whose
 *  writes should dirty this rule; omitted, the rule only fires on
 *  mint/rebuild. The view is always bound at the unit's active
 *  speculation context — there is no ROOT-privileged sweep mode. */
export function unitSweepRule(
  name: string,
  sweep: (unit: Unit, facts: TransformFactView) => boolean,
  edges: ReadonlyArray<FactEdge<Unit>> = [],
): TransformRule {
  return {
    id: Symbol(name),
    debugName: name,
    edges,
    sweep,
  };
}
