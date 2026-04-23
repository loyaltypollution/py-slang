// Dispatch lane: decides validity of and produces the body for
// speculative compilation at (unit, s). Bodies are compile-only clones —
// they are never inserted into analysis store, CFG, or topology. Cloned
// nodes preserve NodeIds as stable references into the canonical unit.

import { StmtNS } from "../../ast-types";
import { contextIsEntrySpecializable, directParamEntryGuardsFor } from "../entry-guards";
import type { Speculation } from "./assumption-chain";
import { visibleBody } from "./assumption-bodies";
import { shadowNode } from "./ast-deep-clone";
import { typeAnalysis } from "./dfa-analyses";
import type { Unit } from "./function-unit";
import type { ReadonlyProgramTopology } from "./topology";
import { BOOL_BIT, BoolRef } from "../type-analysis/lattice";

function conditionTruth(
  condId: number,
  topology: ReadonlyProgramTopology,
  context: Speculation,
): boolean | undefined {
  const fact = typeAnalysis.perExpr(topology).tryRead(condId, context);
  if (fact === undefined || fact.kinds !== BOOL_BIT) return undefined;
  switch (fact.boolRef) {
    case BoolRef.True: return true;
    case BoolRef.False: return false;
    default: return undefined;
  }
}

/** Prune dead branches under the type facts at `context`. Returns the
 *  original array when no rewrite was needed. */
function pruneWithFactsAt(
  stmts: readonly StmtNS.Stmt[],
  context: Speculation,
  topology: ReadonlyProgramTopology,
): readonly StmtNS.Stmt[] {
  let changed = false;
  const out: StmtNS.Stmt[] = [];
  for (const stmt of stmts) {
    if (!(stmt instanceof StmtNS.If)) {
      out.push(stmt);
      continue;
    }
    const truth = conditionTruth(stmt.condition.id, topology, context);
    if (truth === true) {
      changed = true;
      out.push(...pruneWithFactsAt(stmt.body, context, topology));
      continue;
    }
    if (truth === false) {
      changed = true;
      if (stmt.elseBlock) out.push(...pruneWithFactsAt(stmt.elseBlock, context, topology));
      continue;
    }
    const newBody = pruneWithFactsAt(stmt.body, context, topology);
    const newElse = stmt.elseBlock
      ? pruneWithFactsAt(stmt.elseBlock, context, topology)
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

/** Is `(unit, s)` a valid target for speculation-lane dispatch?
 *  When `isRefuted` is omitted, retirement is assumed trivial (tests). */
export function dispatchValid(
  unit: Unit,
  s: Speculation,
  isRefuted?: (s: Speculation) => boolean,
): boolean {
  if (!(unit.funcAst instanceof StmtNS.FunctionDef)) return false;
  if (!contextIsEntrySpecializable(unit, s)) return false;
  if (isRefuted !== undefined && isRefuted(s)) return false;
  if (directParamEntryGuardsFor(unit, s) === undefined) return false;
  return true;
}

/** The body to compile at `(unit, s)`: nearest non-retired ancestor fork
 *  (or `unit.body`) plus dead-branch pruning under the context's type
 *  facts. Reference equality against `unit.body` tells the caller whether
 *  speculation contributed anything. Call `dispatchValid` first. */
export function bodyToCompile(
  unit: Unit,
  s: Speculation,
  topology: ReadonlyProgramTopology,
  isRefuted?: (s: Speculation) => boolean,
): readonly StmtNS.Stmt[] {
  const source = visibleBody(unit, s, isRefuted);
  return pruneWithFactsAt(source, s, topology);
}
