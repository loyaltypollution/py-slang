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

/** Is `(unit, s)` a valid target for speculation-lane dispatch? */
export function dispatchValid(
  unit: Function,
  s: AssumptionChain,
  isRefuted?: (s: AssumptionChain) => boolean,
): boolean {
  if (!(unit.funcAst instanceof StmtNS.FunctionDef)) return false;
  if (!contextIsEntrySpecializable(unit, s)) return false;
  if (isRefuted?.(s)) return false;
  if (directParamEntryGuardsFor(unit, s) === undefined) return false;
  return true;
}

/** Body to compile at `(unit, s)`: nearest non-retired ancestor fork
 *  (or `unit.body`), dead-branch-pruned under `s`'s type facts.
 *  Reference equality vs `unit.body` indicates whether speculation contributed.
 *  Requires `dispatchValid(unit, s, isRefuted)`. */
export function bodyToCompile(
  unit: Function,
  s: AssumptionChain,
  view: FunctionLocator,
  isRefuted?: (s: AssumptionChain) => boolean,
): readonly StmtNS.Stmt[] {
  if (!dispatchValid(unit, s, isRefuted)) {
    throw new Error("[bodyToCompile] dispatchValid(unit, s, isRefuted) must hold");
  }
  return pruneWithFactsAt(visibleBody(unit, s, isRefuted), s, view);
}
