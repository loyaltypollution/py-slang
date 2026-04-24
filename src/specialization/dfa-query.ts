// Fact-read projection over DFA facts. Named here (not in framework/) because
// it references concrete analyses; reads route through each analysis's
// per-expression view to keep key space tied to analysis topology.

import type { Unit } from "./framework/function-unit";
import type { FunctionId, NodeId } from "./framework/analysis";
import type { ProgramTopology } from "./framework/topology";
import { ROOT_CONTEXT, type AssumptionChain } from "./assumption/chain";
import {
  constAnalysis,
  type ConstLattice,
  type EntryRequirement,
  purityScopeAnalysis,
  requirementAtEntry,
  typeAnalysis,
  type TypeLattice,
} from "./analysis";

/** ROOT-context reads only — sound to consume during AST mutation. */
export interface StaticDfaQuery {
  typeOf(nodeId: NodeId): TypeLattice | undefined;
  constOf(nodeId: NodeId): ConstLattice | undefined;
  isPureScope(scopeId: FunctionId): boolean | undefined;
}

/** Adds speculation readers for backend emission (requires runtime guard). */
export interface DfaQuery extends StaticDfaQuery {
  speculativeTypeOf(nodeId: NodeId): TypeLattice | undefined;
  speculativeConstOf(nodeId: NodeId): ConstLattice | undefined;
  entryRequirementsOf(scopeId: FunctionId): EntryRequirement | undefined;
}

export function makeDfaQuery(
  topology: ProgramTopology,
  futureDispatchChainForNode: (nodeId: NodeId) => AssumptionChain = () => ROOT_CONTEXT,
  futureDispatchChainForUnit: (unit: Unit) => AssumptionChain = () => ROOT_CONTEXT,
): DfaQuery {
  const typeStore = typeAnalysis.perExpr(topology);
  const constStore = constAnalysis.perExpr(topology);
  return {
    typeOf: id => typeStore.tryRead(id, ROOT_CONTEXT),
    constOf: id => constStore.tryRead(id, ROOT_CONTEXT),
    speculativeTypeOf: id =>
      typeStore.tryRead(id, futureDispatchChainForNode(id)),
    speculativeConstOf: id =>
      constStore.tryRead(id, futureDispatchChainForNode(id)),
    entryRequirementsOf: scopeId => {
      const unit = topology.units.get(scopeId);
      if (unit === undefined) return undefined;
      return requirementAtEntry(unit, futureDispatchChainForUnit(unit));
    },
    isPureScope: scopeId => {
      const unit = topology.units.get(scopeId);
      const context = unit !== undefined ? futureDispatchChainForUnit(unit) : ROOT_CONTEXT;
      return purityScopeAnalysis.store.readDeepest(context, scopeId)?.value;
    },
  };
}
