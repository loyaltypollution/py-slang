// Application-layer fact-read projection over the DFA facts. Lives
// outside `framework/worklist.ts` because it names concrete analyses
// (typeAnalysis, constAnalysis, purityScopeAnalysis, requirementAtEntry).
// Reads route through each analysis's per-expression view so the key space
// stays tied to the analysis topology.

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

/** Transform-safe projection of the current DFA facts: only reads that
 *  are sound to consume during AST mutation. Excludes speculative readers
 *  — a narrowed fact can become ⊤ on the next observation (deopt), and a
 *  transform that rewrote based on the narrowed fact cannot un-rewrite.
 *  AST-mutating code MUST accept only this sub-interface. */
export interface StaticDfaQuery {
  typeOf(nodeId: NodeId): TypeLattice | undefined;
  constOf(nodeId: NodeId): ConstLattice | undefined;
  /** Purity verdict for a FunctionDef scope. `true` = no observable side
   *  effects ⇒ safe to whole-call deopt re-entry. `false` = impure.
   *  `undefined` = not yet computed (treat as impure for safety). */
  isPureScope(scopeId: FunctionId): boolean | undefined;
}

/** Full DfaQuery extends `StaticDfaQuery` with speculation readers —
 *  intended for backend emission, where a runtime guard protects against
 *  violation of the narrowed fact. NOT sound for AST mutation. Guard
 *  violations retract speculation; once pruned, speculative readers return
 *  the non-narrowed ROOT facts and the compiler falls back naturally. */
export interface DfaQuery extends StaticDfaQuery {
  /** Speculatively-narrowed type fact. Consumers MUST emit a runtime
   *  guard at any specialization decision that depends on a tighter
   *  answer than `typeOf` would give. */
  speculativeTypeOf(nodeId: NodeId): TypeLattice | undefined;
  speculativeConstOf(nodeId: NodeId): ConstLattice | undefined;
  /** Guard-hoistable entry requirements for a FunctionDef under its active
   *  speculation context. Consumable only when the backend also emits a
   *  runtime guard covering the producing assumption chain. */
  entryRequirementsOf(scopeId: FunctionId): EntryRequirement | undefined;
}

export function makeDfaQuery(
  topology: ProgramTopology,
  /** Future-dispatch chain for a node's owning unit, or ROOT_CONTEXT if
   *  nothing has been speculated yet. */
  futureDispatchChainForNode: (nodeId: NodeId) => AssumptionChain = () => ROOT_CONTEXT,
  /** Future-dispatch chain for a unit. Defaults to ROOT for callers that
   *  do not participate in speculative compilation. */
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
