// Dispatch lane: deciding whether a speculative body can be produced at
// (unit, s), and producing the body to compile.
//
// The two responsibilities are separated so the dispatch-validity check
// doesn't conflate "speculation buys nothing over the baseline" with
// "decline to specialize." The old specializedBodyFor overloaded both
// into a single undefined return, which silently dropped ancestor-
// published forks whenever the context carried a non-param assumption.
//
// Produces a cloned, rewritten function body for speculative compilation.
// The clone is compile-only data — it must never be inserted into the
// analysis store, CFG, topology, or any framework structure that treats
// NodeId as owning mutable program identity. Cloned nodes preserve the
// original NodeId values as stable references back to the canonical
// unit's analysis namespace; fact reads continue to use those ids.
//
// Rewrite family exposed here: dead branch pruning from speculative
// type facts. Whether to apply memoization on top of a pruned body is
// evaluator policy and lives in the evaluator layer. Shared AST is
// never mutated.

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
  if (fact.boolRef === BoolRef.True) return true;
  if (fact.boolRef === BoolRef.False) return false;
  return undefined;
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
    if (stmt instanceof StmtNS.If) {
      const truth = conditionTruth(stmt.condition.id, topology, context);
      if (truth === true) {
        changed = true;
        out.push(...pruneWithFactsAt(stmt.body, context, topology));
        continue;
      }
      if (truth === false) {
        changed = true;
        if (stmt.elseBlock) {
          out.push(...pruneWithFactsAt(stmt.elseBlock, context, topology));
        }
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
      continue;
    }
    out.push(stmt);
  }
  return changed ? out : stmts;
}

/** Is `(unit, s)` a valid target for speculation-lane dispatch?
 *
 *  Four conjoined checks:
 *   - `unit.funcAst` is a FunctionDef.
 *   - `contextIsEntrySpecializable(unit, s)` — every assumption in `s`
 *     is of a kind the entry-guard machinery can lower.
 *   - `!isRefuted(s)` — the retirement filter has no generator that is
 *     a subset of `s`. Under algebraic `isRefuted` this single query
 *     covers every retired generator transitively.
 *   - `directParamEntryGuardsFor(unit, s) !== undefined` — there are
 *     concrete param-type assumptions to emit guards from.
 *
 *  When `isRefuted` is omitted, retirement is assumed trivial (useful
 *  for unit tests on pure dispatch predicates). Production call sites
 *  supply the worklist's algebraic predicate. */
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

/** The body to compile at `(unit, s)`. Always returns a body (total
 *  function): starts from the nearest non-retired ancestor fork (or
 *  `unit.body` if none) and layers dead-branch pruning under the
 *  context's type facts. Reference-equality against `unit.body` tells a
 *  caller whether speculation contributed anything:
 *
 *    result === unit.body  → no ancestor fork, pruner was a no-op;
 *                            caller should use baseline compilation.
 *    result !== unit.body  → either an ancestor rewrite, the pruner
 *                            fired, or both; caller compiles the clone.
 *
 *  Preconditions: call `dispatchValid(unit, s, isRefuted)` first. This
 *  function does not re-check admissibility. */
export function bodyToCompile(
  unit: Unit,
  s: Speculation,
  topology: ReadonlyProgramTopology,
  isRefuted?: (s: Speculation) => boolean,
): readonly StmtNS.Stmt[] {
  const source = visibleBody(unit, s, isRefuted);
  return pruneWithFactsAt(source, s, topology);
}
