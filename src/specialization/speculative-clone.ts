// Speculative-clone lane: per-(Unit, Context) specialized function bodies.
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
// v2 rewrite families:
//   1. dead branch pruning from speculative const/type facts;
//   2. speculative memoization once pruning makes the cloned body pure and the
//      profitability signal says the work is worthwhile.
// Shared AST is never mutated.

import { ExprNS, StmtNS } from "../ast-types";
import {
  contextIsEntrySpecializable,
  directParamEntryGuardsFor,
  guardKeyFor,
} from "./entry-guards";
import { ROOT_CONTEXT, type Context } from "./framework/context";
import type { Unit } from "./framework/function-unit";
import type { ProgramTopology } from "./framework/topology";
import { constAnalysis, typeAnalysis } from "./framework/dfa-analyses";
import { readExprFact } from "./framework/dfa-factory";
import {
  MEMOIZATION_THRESHOLD,
  memoWrappedBody,
} from "./transforms/memoization";
import { runtimeCallAnalysis } from "./framework/runtime-analyses";
import { BOOL_BIT, BoolRef } from "./type-analysis/lattice";

function constTruth(
  condId: number,
  topology: ProgramTopology,
  context: Context,
): boolean | undefined {
  const fact = readExprFact(topology, constAnalysis, condId, context);
  if (fact === undefined || fact.tag !== "const") return undefined;
  return Boolean(fact.value);
}

function typeTruth(
  condId: number,
  topology: ProgramTopology,
  context: Context,
): boolean | undefined {
  const fact = readExprFact(topology, typeAnalysis, condId, context);
  if (fact === undefined || fact.kinds !== BOOL_BIT) return undefined;
  if (fact.boolRef === BoolRef.True) return true;
  if (fact.boolRef === BoolRef.False) return false;
  return undefined;
}

function conditionTruth(
  condId: number,
  topology: ProgramTopology,
  context: Context,
): boolean | undefined {
  return constTruth(condId, topology, context) ?? typeTruth(condId, topology, context);
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
  topology: ProgramTopology,
  context: Context,
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
      // Condition not const: recurse into arms. Return original stmt when
      // neither arm changed (avoids unnecessary shadow allocation).
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

function exprIsClonePure(expr: ExprNS.Expr, selfName: string): boolean {
  if (
    expr instanceof ExprNS.Literal ||
    expr instanceof ExprNS.BigIntLiteral ||
    expr instanceof ExprNS.Complex ||
    expr instanceof ExprNS.None ||
    expr instanceof ExprNS.Variable
  ) return true;
  if (expr instanceof ExprNS.Grouping) return exprIsClonePure(expr.expression, selfName);
  if (expr instanceof ExprNS.Binary || expr instanceof ExprNS.Compare || expr instanceof ExprNS.BoolOp) {
    return exprIsClonePure(expr.left, selfName) && exprIsClonePure(expr.right, selfName);
  }
  if (expr instanceof ExprNS.Unary) return exprIsClonePure(expr.right, selfName);
  if (expr instanceof ExprNS.Ternary) {
    return exprIsClonePure(expr.predicate, selfName)
      && exprIsClonePure(expr.consequent, selfName)
      && exprIsClonePure(expr.alternative, selfName);
  }
  if (expr instanceof ExprNS.List) return expr.elements.every(el => exprIsClonePure(el, selfName));
  if (expr instanceof ExprNS.Subscript) {
    return exprIsClonePure(expr.value, selfName) && exprIsClonePure(expr.index, selfName);
  }
  if (expr instanceof ExprNS.Call) {
    if (!(expr.callee instanceof ExprNS.Variable)) return false;
    const callee = expr.callee.name.lexeme;
    if (callee !== selfName && callee !== "range" && callee !== "len" && callee !== "abs"
      && callee !== "min" && callee !== "max" && callee !== "int" && callee !== "float"
      && callee !== "str" && callee !== "bool" && callee !== "round"
      && callee !== "__memo_has" && callee !== "__memo_get" && callee !== "__memo_put") {
      return false;
    }
    return expr.args.every(arg => exprIsClonePure(arg, selfName));
  }
  return false;
}

function stmtsAreClonePure(stmts: readonly StmtNS.Stmt[], selfName: string): boolean {
  for (const stmt of stmts) {
    if (stmt instanceof StmtNS.Return) {
      if (stmt.value !== null && !exprIsClonePure(stmt.value, selfName)) return false;
      continue;
    }
    if (stmt instanceof StmtNS.Assign) {
      if (!(stmt.target instanceof ExprNS.Variable)) return false;
      if (!exprIsClonePure(stmt.value, selfName)) return false;
      continue;
    }
    if (stmt instanceof StmtNS.If) {
      if (!exprIsClonePure(stmt.condition, selfName)) return false;
      if (!stmtsAreClonePure(stmt.body, selfName)) return false;
      if (stmt.elseBlock && !stmtsAreClonePure(stmt.elseBlock, selfName)) return false;
      continue;
    }
    if (stmt instanceof StmtNS.While) {
      if (!exprIsClonePure(stmt.condition, selfName)) return false;
      if (!stmtsAreClonePure(stmt.body, selfName)) return false;
      continue;
    }
    if (stmt instanceof StmtNS.For) return false;
    if (stmt instanceof StmtNS.SimpleExpr) {
      if (!exprIsClonePure(stmt.expression, selfName)) return false;
      continue;
    }
    return false;
  }
  return true;
}

function maybeMemoize(
  unit: Unit,
  body: readonly StmtNS.Stmt[],
  context: Context,
): readonly StmtNS.Stmt[] {
  const fd = unit.funcAst;
  if (!(fd instanceof StmtNS.FunctionDef)) return body;
  const hot = runtimeCallAnalysis.store.tryRead(fd.id, ROOT_CONTEXT) ?? 0;
  if (hot < MEMOIZATION_THRESHOLD) return body;
  if (!stmtsAreClonePure(body, fd.name.lexeme)) return body;
  return memoWrappedBody(fd, body, guardKeyFor(unit, context));
}

/** Cheap predicate for whether the current speculative lane could produce a
 *  specialized cloned body for `(unit, context)`. */
export function hasSpecializedBody(
  unit: Unit,
  context: Context,
  topology: ProgramTopology,
): boolean {
  return specializedBodyFor(unit, context, topology) !== undefined;
}

/** Return a cloned, rewritten body for speculative compilation, or undefined
 *  when no rewrite is possible.
 *
 *  Callers MUST NOT insert the returned nodes into topology / CFG / analysis
 *  stores. Returned nodes preserve original NodeIds and are compilation
 *  artifacts only.
 *
 *  Returns undefined when:
 *  - the unit is not a FunctionDef, or
 *  - no speculative rewrite applied under the given context. */
export function specializedBodyFor(
  unit: Unit,
  context: Context,
  topology: ProgramTopology,
): ReadonlyArray<StmtNS.Stmt> | undefined {
  if (!(unit.funcAst instanceof StmtNS.FunctionDef)) return undefined;
  if (!contextIsEntrySpecializable(unit, context)) return undefined;
  const guards = directParamEntryGuardsFor(unit, context);
  if (guards === undefined) return undefined;
  const pruned = pruneStmts(unit.body, topology, context);
  const memoized = maybeMemoize(unit, pruned, context);
  return memoized !== unit.body ? memoized : undefined;
}
