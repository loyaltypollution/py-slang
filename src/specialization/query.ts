import type { ConstLattice } from "./const-analysis/lattice";
import type { TypeLattice } from "./type-analysis/lattice";
import { readExprFact } from "./framework/dfa-factory";
import { constAnalysisPass, typeAnalysisPass } from "./framework/dfa-passes";
import type { FactStore } from "./framework/fact-store";
import type { FunctionUnit } from "./framework/function-unit";

// Per-node read-only projection of the DFA fact-store. Resolves the containing
// BasicBlock internally via `nodeIndex`, so callers identify nodes by id alone
// and never touch FactStore / passes / blocks directly.
export interface DfaQuery {
  typeOf(nodeId: number): TypeLattice | undefined;
  constOf(nodeId: number): ConstLattice | undefined;
}

export function makeDfaQuery(
  factStore: FactStore,
  nodeIndex: ReadonlyMap<number, FunctionUnit>,
): DfaQuery {
  const blockFor = (id: number) => nodeIndex.get(id)?.blockOfNode.get(id);
  return {
    typeOf: id => readExprFact(factStore, typeAnalysisPass, blockFor(id), id),
    constOf: id => readExprFact(factStore, constAnalysisPass, blockFor(id), id),
  };
}
