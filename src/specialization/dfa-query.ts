// Application-layer fact-read projection over the DFA facts.
//
// These interfaces and the factory are deliberately NOT in
// `framework/worklist.ts` — they name concrete analyses (typeAnalysis,
// constAnalysis, purityScopeAnalysis) and concrete lattices (TypeLattice,
// ConstLattice), which is appropriate at the application layer where the
// analysis set is chosen, not inside the generic scheduler. Reads go through
// the analysis's per-expression view — `analysis.perExpr(topology).tryRead`
// — so the key space stays tied to the analysis topology instead of the
// chain.

import type { Unit } from "./framework/function-unit";
import type { FunctionId, NodeId } from "./framework/key-spaces";
import type { ProgramTopology } from "./framework/topology";
import { ROOT_CONTEXT, type AssumptionChain } from "./framework/assumption-chain";
import { constAnalysis, typeAnalysis } from "./framework/dfa-analyses";
import { purityScopeAnalysis } from "./purity-analysis/analysis";
import type { TypeLattice } from "./type-analysis/lattice";
import type { ConstLattice } from "./const-analysis/lattice";
import {
  requirementAtEntry,
  type EntryRequirement,
} from "./type-requirement-analysis/analysis";

/** Transform-safe projection of the current DFA facts: only reads that are
 *  sound to consume during AST mutation. Excludes speculative readers —
 *  a narrowed fact at a node can become ⊤ on the next observation (deopt),
 *  and a transform that rewrote the AST based on the narrowed fact cannot
 *  safely un-rewrite. Anything mutating the AST MUST accept only this
 *  sub-interface; the type gate is the enforcement mechanism for P3. */
export interface StaticDfaQuery {
  typeOf(nodeId: NodeId): TypeLattice | undefined;
  constOf(nodeId: NodeId): ConstLattice | undefined;
  /** Purity verdict for a FunctionDef scope. `true` = no observable side
   *  effects ⇒ safe to whole-call deopt re-entry. `false` = impure.
   *  `undefined` = not yet computed (treat as impure for safety). */
  isPureScope(scopeId: FunctionId): boolean | undefined;
}

/** Full DfaQuery extends `StaticDfaQuery` with speculation readers — intended
 *  for backend emission (svml-compiler, jit-analysis) where a runtime guard
 *  protects against violation of the narrowed fact. NOT sound for AST
 *  mutation; transforms should be typed against `StaticDfaQuery` only.
 *
 *  Guard violations retract speculation by pruning the unit's active spec
 *  context (see `Worklist.widenUnitSpeculation`). Once pruned, the same
 *  `speculative{Type,Const}Of` calls return the non-narrowed ROOT facts,
 *  and the compiler naturally falls back to generic opcodes — no separate
 *  blacklist gate. */
export interface DfaQuery extends StaticDfaQuery {
  /** Speculatively-narrowed type fact (observation `meet`'d with static).
   *  Consumers MUST emit a runtime guard at any specialization decision
   *  that depends on a tighter answer than `typeOf` would give. */
  speculativeTypeOf(nodeId: NodeId): TypeLattice | undefined;
  speculativeConstOf(nodeId: NodeId): ConstLattice | undefined;
  /** Guard-hoistable entry requirements for a FunctionDef under its active
   *  speculation context. Backends may consume these only when they also emit
   *  a runtime guard covering the assumption chain that produced them. */
  entryRequirementsOf(scopeId: FunctionId): EntryRequirement | undefined;
}

export function makeDfaQuery(
  topology: ProgramTopology,
  /** Resolve the future-dispatch chain for a node's owning unit, or
   *  ROOT_CONTEXT if nothing has been speculated yet. Both
   *  `speculativeTypeOf` and `speculativeConstOf` read the respective
   *  analysis under the returned context — same analyses, same storage
   *  dimension, no parallel twins. */
  futureDispatchChainForNode: (nodeId: NodeId) => AssumptionChain = () => ROOT_CONTEXT,
  /** Resolve the future-dispatch chain for a unit. Used by guarded
   *  backend consumers such as entry-guard hoisting for return-kind
   *  specialization. Defaults to ROOT for callers that do not participate in
   *  speculative compilation. */
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
      const unit = topology.unitOfFunctionId(scopeId);
      if (unit === undefined) return undefined;
      return requirementAtEntry(unit, futureDispatchChainForUnit(unit));
    },
    isPureScope: scopeId => {
      const unit = topology.unitOfFunctionId(scopeId);
      const context = unit !== undefined ? futureDispatchChainForUnit(unit) : ROOT_CONTEXT;
      return purityScopeAnalysis.readDeepest(context, scopeId)?.value;
    },
  };
}
