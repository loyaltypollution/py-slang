// Speculative-clone lane: per-(Unit, AssumptionChain) specialized function bodies.
//
// Produces a cloned, rewritten function body for speculative compilation.
// The clone is compile-only data — it must never be inserted into the
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
// policy and lives in the evaluator layer (e.g. PySvmlJitEvaluator.ts).
// Shared AST is never mutated.

import { StmtNS } from "../ast-types";
import {
  contextIsEntrySpecializable,
  directParamEntryGuardsFor,
} from "./entry-guards";
import { shadowNode } from "./framework/ast-deep-clone";
import type { AssumptionChain } from "./framework/assumption-chain";
import type { Unit } from "./framework/function-unit";
import type { ReadonlyProgramTopology } from "./framework/topology";
import { typeAnalysis } from "./framework/dfa-analyses";
import { BOOL_BIT, BoolRef } from "./type-analysis/lattice";

function conditionTruth(
  condId: number,
  topology: ReadonlyProgramTopology,
  context: AssumptionChain,
): boolean | undefined {
  const fact = typeAnalysis.perExpr(topology).tryRead(condId, context);
  if (fact === undefined || fact.kinds !== BOOL_BIT) return undefined;
  if (fact.boolRef === BoolRef.True) return true;
  if (fact.boolRef === BoolRef.False) return false;
  return undefined;
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
        out.push(shadowNode(stmt, { body: newBody as StmtNS.Stmt[], elseBlock: newElse as StmtNS.Stmt[] | null }));
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
  isRetired?: (node: AssumptionChain) => boolean,
): boolean {
  return specializedBodyFor(unit, context, topology, isRetired) !== undefined;
}

/** Return a cloned, dead-branch-pruned body for speculative compilation, or
 *  undefined when no pruning applies.
 *
 *  Speculative pruning is type-driven only — runtime speculation is policy-
 *  limited to the type domain (see DEFAULT_NARROWINGS), so this lane
 *  ignores const facts even when they happen to exist. Static const reasoning
 *  remains available through the regular transform pipeline (deadBranch,
 *  constFold) at ROOT.
 *
 *  Callers MUST NOT insert the returned nodes into topology / CFG / analysis
 *  stores. Returned nodes preserve original NodeIds and are compile-only
 *  data.
 *
 *  Memoization is owned by `memoizationRule` (transforms/memoization.ts),
 *  which publishes at its purity witness via `witnessChain.forkBody(unit)`;
 *  this function reads via `context.visibleBody(unit)`, so a memo-wrapped
 *  body at an ancestor witness is already visible in the returned clone.
 *
 *  Returns undefined when:
 *  - the unit is not a FunctionDef, or
 *  - the context is not entry-specializable (contains non-param assumptions), or
 *  - no dead-branch pruning applied under the given context. */
export function specializedBodyFor(
  unit: Unit,
  context: AssumptionChain,
  topology: ReadonlyProgramTopology,
  isRetired?: (node: AssumptionChain) => boolean,
): ReadonlyArray<StmtNS.Stmt> | undefined {
  if (!(unit.funcAst instanceof StmtNS.FunctionDef)) return undefined;
  if (!contextIsEntrySpecializable(unit, context)) return undefined;
  // Retirement check: if any ancestor of `context` (including `context`
  // itself) has been retired by a conflicting runtime observation, its
  // authorization is gone. Decline to specialize so the evaluator falls
  // back to the baseline ROOT body.
  if (isRetired !== undefined) {
    for (let cur: AssumptionChain | undefined = context; cur !== undefined; cur = cur.parent) {
      if (isRetired(cur)) return undefined;
    }
  }
  const guards = directParamEntryGuardsFor(unit, context);
  if (guards === undefined) return undefined;
  // Start from the body visible at `context`: if a context-aware transform
  // (e.g. memoization) already rewrote at an ancestor, we pick that rewrite
  // up for free. Pruning is then a backend-local clone — it does not mutate
  // the stored body.
  const source = context.visibleBody(unit);
  const pruned = pruneStmts(source, topology, context);
  // Return a specialized body whenever EITHER (a) pruning made further
  // changes here, or (b) `source` is already a speculation-owned fork
  // carrying a rewrite published by a context-aware transform at an
  // ancestor (e.g. memoizationRule). Returning `undefined` in case (b)
  // would drop that rewrite: the evaluator falls back to `funcAst.body`
  // (ROOT), recompiling the un-rewritten program.
  if (pruned !== source) return pruned;
  if (source !== unit.body) return source;
  return undefined;
}
