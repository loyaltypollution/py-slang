// Helper for unit-keyed transform rules. The worklist sweeps each rule's
// dirty set after analyses converge; rules that rewrote return `true` to
// schedule a CFG rebuild. Idempotency across rebuilds is the caller's
// concern — the rewrite must make its own precondition fail (dead-branch
// removes the branch; const-fold replaces the variable; memoization detects
// its own prelude). Rules that cannot become precondition-false on their own
// should not be expressed as sweep-transforms.

import { ROOT_CONTEXT } from "./context";
import type { FactEdge, TransformRule, TransformFactView } from "./analysis";
import { readExprFact } from "./dfa-factory";
import type { Unit } from "./function-unit";
import type { ProgramTopology } from "./topology";

export type { TransformFactView };

/** Construct the root-only `TransformFactView` that transforms see inside
 *  `sweep`. Every read delegates to `analysis.store` at `ROOT_CONTEXT`.
 *  Semantic reads and opaque/profitability reads are split at the type level
 *  so transforms must name profitability evidence explicitly. */
export function rootTransformFacts(topology: ProgramTopology): TransformFactView {
  return {
    read: (analysis, key) => analysis.store.read(key, ROOT_CONTEXT),
    tryRead: (analysis, key) => analysis.store.tryRead(key, ROOT_CONTEXT),
    readAll: analysis => analysis.store.readAll(ROOT_CONTEXT),
    readExprFact: (analysis, nodeId) => readExprFact(topology, analysis, nodeId, ROOT_CONTEXT),
    readProfitability: (analysis, key) => analysis.store.read(key, ROOT_CONTEXT),
  };
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
    sweep(unit: Unit, facts: TransformFactView): boolean {
      return sweep(unit, facts);
    },
  };
}
