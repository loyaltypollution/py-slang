import type { Function } from "./program/function";
import type { NodeId } from "./framework/analysis";
import type { FunctionId, FunctionView } from "./program/program-view";
import { ROOT_CONTEXT, type AssumptionChain } from "./assumption/chain";
import {
  constAnalysis,
  type ConstLattice,
  type EntryRequirement,
  purityFunctionAnalysis,
  requirementAtEntry,
  typeAnalysis,
  type TypeLattice,
} from "./analysis";

export interface StaticDfaQuery {
  typeOf(nodeId: NodeId): TypeLattice | undefined;
  constOf(nodeId: NodeId): ConstLattice | undefined;
  isPureScope(scopeId: FunctionId): boolean | undefined;
}

export interface DfaQuery extends StaticDfaQuery {
  speculativeTypeOf(nodeId: NodeId): TypeLattice | undefined;
  speculativeConstOf(nodeId: NodeId): ConstLattice | undefined;
  entryRequirementsOf(scopeId: FunctionId): EntryRequirement | undefined;
}

export function makeDfaQuery(
  view: FunctionView,
  futureDispatchChainForNode: (nodeId: NodeId) => AssumptionChain = () => ROOT_CONTEXT,
  futureDispatchChainForUnit: (unit: Function) => AssumptionChain = () => ROOT_CONTEXT,
): DfaQuery {
  const typeStore = typeAnalysis.perExpr(view);
  const constStore = constAnalysis.perExpr(view);
  return {
    typeOf: id => typeStore.tryRead(id, ROOT_CONTEXT),
    constOf: id => constStore.tryRead(id, ROOT_CONTEXT),
    speculativeTypeOf: id =>
      typeStore.tryRead(id, futureDispatchChainForNode(id)),
    speculativeConstOf: id =>
      constStore.tryRead(id, futureDispatchChainForNode(id)),
    entryRequirementsOf: scopeId => {
      const unit = view.functions.get(scopeId);
      if (unit === undefined) return undefined;
      return requirementAtEntry(unit, futureDispatchChainForUnit(unit));
    },
    isPureScope: scopeId => {
      const unit = view.functions.get(scopeId);
      if (unit === undefined) return undefined;
      return purityFunctionAnalysis.store.readDeepest(futureDispatchChainForUnit(unit), unit)?.value;
    },
  };
}
