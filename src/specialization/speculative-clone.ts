// Speculative-clone lane: per-(Unit, AssumptionChain) specialized function bodies.
//
// Produces a cloned, rewritten function body for speculative compilation.
// The clone is a compilation artifact — it must never be inserted into the
// analysis store, CFG, topology, or any framework structure that treats NodeId
// as owning mutable program identity.
//
// NodeId shadow policy (v1): cloned nodes preserve the original NodeId values
// as stable references back to the canonical unit's analysis namespace. All
// semantic facts are read from the original unit's analyses using the original
// NodeId namespace. Fresh-NodeId remapping is explicitly out-of-scope for v1.
//
// Rewrite family exposed here: dead branch pruning from speculative const/type
// facts. Whether to apply memoization on top of a pruned body is evaluator
// policy and lives in the evaluator layer (e.g. svml-jit-analysis.ts).
// Shared AST is never mutated.

import { StmtNS } from "../ast-types";
import {
  contextIsEntrySpecializable,
  directParamEntryGuardsFor,
} from "./entry-guards";
import type { AssumptionChain } from "./framework/context";
import type { Unit } from "./framework/function-unit";
import type { ReadonlyProgramTopology } from "./framework/topology";
import { typeAnalysis } from "./framework/dfa-analyses";
import { readExprFact } from "./framework/dfa-factory";
import { bodyFor } from "./framework/chain-body-store";
import { BOOL_BIT, BoolRef } from "./type-analysis/lattice";

function conditionTruth(
  condId: number,
  topology: ReadonlyProgramTopology,
  context: AssumptionChain,
): boolean | undefined {
  const fact = readExprFact(topology, typeAnalysis, condId, context);
  if (fact === undefined || fact.kinds !== BOOL_BIT) return undefined;
  if (fact.boolRef === BoolRef.True) return true;
  if (fact.boolRef === BoolRef.False) return false;
  return undefined;
}

/** Shadow-copy an If node with new body/elseBlock, preserving the original id.
 *  Uses prototype inheritance so instanceof checks still pass. */
function shadowIf(
  orig: StmtNS.If,
  body: StmtNS.Stmt[],
  elseBlock: StmtNS.Stmt[] | null,
): StmtNS.If {
  const shadow = Object.create(Object.getPrototypeOf(orig)) as StmtNS.If;
  Object.assign(shadow, orig, { body, elseBlock });
  return shadow;
}

/** Prune dead branches in a statement list.
 *  Returns the original array reference when no rewrite was needed. */
function pruneStmts(
  stmts: readonly StmtNS.Stmt[],
  topology: ReadonlyProgramTopology,
  context: AssumptionChain,
): readonly StmtNS.Stmt[] {
  let changed = false;
  const out: StmtNS.Stmt[] = [];

  for (const stmt of stmts) {
    if (stmt instanceof StmtNS.If) {
      const truth = conditionTruth(stmt.condition.id, topology, context);
      if (truth === true) {
        changed = true;
        out.push(...pruneStmts(stmt.body, topology, context));
        continue;
      }
      if (truth === false) {
        changed = true;
        if (stmt.elseBlock) {
          out.push(...pruneStmts(stmt.elseBlock, topology, context));
        }
        continue;
      }
      const newBody = pruneStmts(stmt.body, topology, context);
      const newElse = stmt.elseBlock
        ? pruneStmts(stmt.elseBlock, topology, context)
        : stmt.elseBlock;
      if (newBody !== stmt.body || newElse !== stmt.elseBlock) {
        changed = true;
        out.push(shadowIf(stmt, newBody as StmtNS.Stmt[], newElse as StmtNS.Stmt[] | null));
      } else {
        out.push(stmt);
      }
      continue;
    }
    out.push(stmt);
  }

  return changed ? out : stmts;
}

/** Cheap predicate for whether the current speculative lane could produce a
 *  specialized cloned body for `(unit, context)`. */
export function hasSpecializedBody(
  unit: Unit,
  context: AssumptionChain,
  topology: ReadonlyProgramTopology,
): boolean {
  return specializedBodyFor(unit, context, topology) !== undefined;
}

/** Return a cloned, dead-branch-pruned body for speculative compilation, or
 *  undefined when no pruning applies.
 *
 *  Speculative pruning is type-driven only — runtime speculation is policy-
 *  limited to the type domain (see JIT_RELEVANT_NARROWINGS), so this lane
 *  ignores const facts even when they happen to exist. Static const reasoning
 *  remains available through the regular transform pipeline (deadBranch,
 *  constFold) at ROOT.
 *
 *  Callers MUST NOT insert the returned nodes into topology / CFG / analysis
 *  stores. Returned nodes preserve original NodeIds and are compilation
 *  artifacts only.
 *
 *  Memoization is owned by `memoizationRule` (transforms/memoization.ts),
 *  which publishes into the chain-body-store at its purity witness;
 *  this function reads via `bodyFor`, so a memo-wrapped body at an
 *  ancestor witness is already visible in the returned clone.
 *
 *  Returns undefined when:
 *  - the unit is not a FunctionDef, or
 *  - the context is not entry-specializable (contains non-param assumptions), or
 *  - no dead-branch pruning applied under the given context. */
export function specializedBodyFor(
  unit: Unit,
  context: AssumptionChain,
  topology: ReadonlyProgramTopology,
): ReadonlyArray<StmtNS.Stmt> | undefined {
  if (!(unit.funcAst instanceof StmtNS.FunctionDef)) return undefined;
  if (!contextIsEntrySpecializable(unit, context)) return undefined;
  const guards = directParamEntryGuardsFor(unit, context);
  if (guards === undefined) return undefined;
  // Start from the body visible at `context` in the chain-body-store: if a
  // context-aware transform (e.g. memoization) already rewrote at an
  // ancestor, we pick that rewrite up for free. Pruning is then a
  // backend-local clone — it does not mutate the stored body.
  const source = bodyFor(unit, context);
  const pruned = pruneStmts(source, topology, context);
  return pruned !== source ? pruned : undefined;
}
