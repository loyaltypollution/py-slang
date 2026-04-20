// Helper for unit-keyed transform rules. The worklist sweeps each rule's
// dirty set after analyses converge; rules that rewrote return `true` to
// schedule a CFG rebuild. Idempotency across rebuilds is the caller's
// concern — the rewrite must make its own precondition fail (dead-branch
// removes the branch; const-fold replaces the variable; memoization detects
// its own prelude). Rules that cannot become precondition-false on their own
// should not be expressed as sweep-transforms.

import { ROOT_CONTEXT, type AssumptionChain } from "./context";
import type { FactEdge, Reading, TransformRule, TransformFactView } from "./analysis";
import { readExprFact } from "./dfa-factory";
import type { Unit } from "./function-unit";
import type { ProgramTopology } from "./topology";

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
    read: (analysis, key) => analysis.store.tryRead(key, context) ?? analysis.store.read(key, ROOT_CONTEXT),
    tryRead: (analysis, key) => analysis.store.tryRead(key, context) ?? analysis.store.tryRead(key, ROOT_CONTEXT),
    readAll: analysis => analysis.store.readAll(context).size > 0 ? analysis.store.readAll(context) : analysis.store.readAll(ROOT_CONTEXT),
    readAt: (analysis, key) => ({ value: analysis.store.read(key, context), witness: context }),
    readMinimal: (analysis, key, accept) =>
      readMinimalExact(context, ctx => analysis.store.tryRead(key, ctx), accept),
    readExprFact: (analysis, nodeId) => readExprFact(topology, analysis, nodeId, context)
      ?? readExprFact(topology, analysis, nodeId, ROOT_CONTEXT),
    readExprFactAt: (analysis, nodeId) => {
      const value = readExprFact(topology, analysis, nodeId, context);
      return value === undefined ? undefined : { value, witness: context };
    },
    readExprFactMinimal: (analysis, nodeId, accept) =>
      readMinimalExact(context, ctx => readExprFact(topology, analysis, nodeId, ctx), accept),
    readProfitability: (analysis, key) => analysis.store.read(key, profitabilityContext),
  };
}

export function rootTransformFacts(topology: ProgramTopology): TransformFactView {
  return transformFacts(topology, ROOT_CONTEXT, ROOT_CONTEXT);
}

/** Build a unit-keyed transform rule from a sweep function that reads
 *  fact state and mutates `unit.body`. Returns `true` iff the AST was
 *  rewritten. `edges` declares upstream analyses whose writes should
 *  dirty this rule; omitted, the rule only fires on mint / rebuild. */
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
