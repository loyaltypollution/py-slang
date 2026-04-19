// Application-layer fact-read projection over the DFA facts.
//
// These interfaces and the factory are deliberately NOT in
// `framework/worklist.ts` — they name concrete analyses (typeAnalysis,
// constAnalysis, purityScopeAnalysis) and concrete lattices (TypeLattice,
// ConstLattice), which is appropriate at the application layer where the
// analysis set is chosen, not inside the generic scheduler. The framework
// exposes `readExprFact` + `ProgramTopology`; this module assembles a
// typed-accessor object on top. Reads go directly through
// `someAnalysis.store.tryRead(...)` — no FactStore middleman.

import type { Unit } from "./framework/function-unit";
import type { FunctionId, NodeId } from "./framework/key-spaces";
import type { ProgramTopology } from "./framework/topology";
import { ROOT_CONTEXT, type Context } from "./framework/context";
import { readExprFact } from "./framework/dfa-factory";
import { constAnalysis, typeAnalysis } from "./framework/dfa-analyses";
import { purityScopeAnalysis } from "./purity-analysis/analysis";
import type { TypeLattice } from "./type-analysis/lattice";
import type { ConstLattice } from "./const-analysis/lattice";
import {
  requirementAtEntry,
  type EntryRequirement,
} from "./type-requirement-analysis/analysis";

/** Transform-safe projection of the DFA fact-store: only reads that are
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
  /** Resolve the active speculation context for a node's owning unit, or
   *  ROOT_CONTEXT if nothing has been speculated yet. Both
   *  `speculativeTypeOf` and `speculativeConstOf` read the respective
   *  analysis under the returned context — same analyses, same storage
   *  dimension, no parallel twins. */
  specContextForNode: (nodeId: NodeId) => Context = () => ROOT_CONTEXT,
  /** Resolve the active speculation context for a unit. Used by guarded
   *  backend consumers such as entry-guard hoisting for return-kind
   *  specialization. Defaults to ROOT for callers that do not participate in
   *  speculative compilation. */
  specContextForUnit: (unit: Unit) => Context = () => ROOT_CONTEXT,
): DfaQuery {
  return {
    typeOf: id => readExprFact(topology, typeAnalysis, id),
    constOf: id => readExprFact(topology, constAnalysis, id),
    speculativeTypeOf: id =>
      readExprFact(topology, typeAnalysis, id, specContextForNode(id)),
    speculativeConstOf: id =>
      readExprFact(topology, constAnalysis, id, specContextForNode(id)),
    entryRequirementsOf: scopeId => {
      const unit = topology.unitOfFunctionId(scopeId);
      if (unit === undefined) return undefined;
      return requirementAtEntry(unit, specContextForUnit(unit));
    },
    isPureScope: scopeId => purityScopeAnalysis.store.tryRead(scopeId, ROOT_CONTEXT),
  };
}
