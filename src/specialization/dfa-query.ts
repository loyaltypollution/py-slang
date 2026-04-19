// Application-layer fact-read projection over the DFA fact store.
//
// These interfaces and the factory are deliberately NOT in
// `framework/worklist.ts` — they name concrete analyses (typeAnalysis,
// constAnalysis, purityScopeAnalysis) and concrete lattices (TypeLattice,
// ConstLattice), which is appropriate at the application layer where the
// analysis set is chosen, not inside the generic scheduler. The framework
// exposes `FactStore` + `readExprFact`; this module assembles a
// typed-accessor object on top.

import type { FactStore } from "./framework/fact-store";
import type { FunctionUnit } from "./framework/function-unit";
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
  typeOf(nodeId: number): TypeLattice | undefined;
  constOf(nodeId: number): ConstLattice | undefined;
  /** Purity verdict for a FunctionDef scope. `true` = no observable side
   *  effects ⇒ safe to whole-call deopt re-entry. `false` = impure.
   *  `undefined` = not yet computed (treat as impure for safety). */
  isPureScope(scopeId: number): boolean | undefined;
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
  speculativeTypeOf(nodeId: number): TypeLattice | undefined;
  speculativeConstOf(nodeId: number): ConstLattice | undefined;
  /** Guard-hoistable entry requirements for a FunctionDef under its active
   *  speculation context. Backends may consume these only when they also emit
   *  a runtime guard covering the assumption chain that produced them. */
  entryRequirementsOf(scopeId: number): EntryRequirement | undefined;
}

export function makeDfaQuery(
  factStore: FactStore,
  nodeIndex: ReadonlyMap<number, FunctionUnit>,
  /** Resolve the active speculation context for a node's owning unit, or
   *  ROOT_CONTEXT if nothing has been speculated yet. Both
   *  `speculativeTypeOf` and `speculativeConstOf` read the respective
   *  analysis under the returned context — same analyses, same storage
   *  dimension, no parallel twins. */
  specContextForNode: (nodeId: number) => Context = () => ROOT_CONTEXT,
  /** Resolve the active speculation context for a unit. Used by guarded
   *  backend consumers such as entry-guard hoisting for return-kind
   *  specialization. Defaults to ROOT for callers that do not participate in
   *  speculative compilation. */
  specContextForUnit: (unit: FunctionUnit) => Context = () => ROOT_CONTEXT,
): DfaQuery {
  const blockFor = (id: number) => nodeIndex.get(id)?.blockOfNode.get(id);
  const unitsByScopeId = new Map<number, FunctionUnit>();
  for (const unit of new Set(nodeIndex.values())) {
    const scope = unit.funcAst;
    if (scope && "id" in scope && typeof scope.id === "number") {
      unitsByScopeId.set(scope.id, unit);
    }
  }
  return {
    typeOf: id => readExprFact(factStore, typeAnalysis, blockFor(id), id),
    constOf: id => readExprFact(factStore, constAnalysis, blockFor(id), id),
    speculativeTypeOf: id =>
      readExprFact(factStore, typeAnalysis, blockFor(id), id, specContextForNode(id)),
    speculativeConstOf: id =>
      readExprFact(factStore, constAnalysis, blockFor(id), id, specContextForNode(id)),
    entryRequirementsOf: scopeId => {
      const unit = unitsByScopeId.get(scopeId);
      if (unit === undefined) return undefined;
      return requirementAtEntry(factStore, unit, specContextForUnit(unit));
    },
    isPureScope: scopeId => factStore.tryRead(purityScopeAnalysis, scopeId),
  };
}
