// Dispatch lane: validity + body for speculative compilation at (unit, s).
// Bodies are compile-only clones; cloned nodes preserve NodeIds.

import { StmtNS } from "../../ast-types";
import { contextIsEntrySpecializable, directParamEntryGuardsFor } from "../narrowing-policy/entry-guards";
import type { AssumptionChain } from "../assumption";
import { visibleBody } from "./assumption-bodies";
import { shadowNode } from "./variant-body-clone";
import type { Function } from "../program/function/function";
import type { FunctionLocator } from "../program/function/manager";
import { BOOL_BIT, BoolRef, typeAnalysis } from "../analysis";

function conditionTruth(
  condId: number,
  view: FunctionLocator,
  context: AssumptionChain,
): boolean | undefined {
  const fact = typeAnalysis.perExpr(view).tryRead(condId, context);
  if (fact === undefined || fact.kinds !== BOOL_BIT) return undefined;
  if (fact.boolRef === BoolRef.True) return true;
  if (fact.boolRef === BoolRef.False) return false;
  return undefined;
}

/** Prune dead branches under type facts at `context`. Returns `stmts` when unchanged. */
function pruneWithFactsAt(
  stmts: readonly StmtNS.Stmt[],
  context: AssumptionChain,
  view: FunctionLocator,
): readonly StmtNS.Stmt[] {
  let changed = false;
  const out: StmtNS.Stmt[] = [];
  for (const stmt of stmts) {
    if (!(stmt instanceof StmtNS.If)) {
      out.push(stmt);
      continue;
    }
    const truth = conditionTruth(stmt.condition.id, view, context);
    if (truth === true) {
      changed = true;
      out.push(...pruneWithFactsAt(stmt.body, context, view));
      continue;
    }
    if (truth === false) {
      changed = true;
      if (stmt.elseBlock) out.push(...pruneWithFactsAt(stmt.elseBlock, context, view));
      continue;
    }
    const newBody = pruneWithFactsAt(stmt.body, context, view);
    const newElse = stmt.elseBlock
      ? pruneWithFactsAt(stmt.elseBlock, context, view)
      : stmt.elseBlock;
    if (newBody !== stmt.body || newElse !== stmt.elseBlock) {
      changed = true;
      out.push(shadowNode(stmt, {
        body: newBody as StmtNS.Stmt[],
        elseBlock: newElse as StmtNS.Stmt[] | null,
      }));
    } else {
      out.push(stmt);
    }
  }
  return changed ? out : stmts;
}

/** Is `(unit, s)` a shape-valid target for speculation-lane dispatch?
 *
 *  Tests entry-specializability and the presence of param entry guards.
 *  Refutation is orthogonal: callers must filter refuted chains before
 *  asking. Mixing the two checks under one predicate hid that contract. */
export function dispatchValid(unit: Function, s: AssumptionChain): boolean {
  if (!(unit.funcAst instanceof StmtNS.FunctionDef)) return false;
  if (!contextIsEntrySpecializable(unit, s)) return false;
  if (directParamEntryGuardsFor(unit, s) === undefined) return false;
  return true;
}

/** Body to compile at `(unit, s)`: deepest stored fork ⊑ `s`
 *  (or `unit.body`), dead-branch-pruned under `s`'s type facts.
 *  Reference equality vs `unit.body` indicates whether speculation contributed.
 *
 *  Preconditions: `dispatchValid(unit, s)` and `s` is non-refuted. */
export function bodyToCompile(
  unit: Function,
  s: AssumptionChain,
  view: FunctionLocator,
): readonly StmtNS.Stmt[] {
  if (!dispatchValid(unit, s)) {
    throw new Error("[bodyToCompile] dispatchValid(unit, s) must hold");
  }
  return pruneWithFactsAt(visibleBody(unit, s), s, view);
}
