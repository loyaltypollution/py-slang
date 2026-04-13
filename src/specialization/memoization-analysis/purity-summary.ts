// src/specialization/memoization-analysis/purity-summary.ts
//
// PurityScopePass — scope-level fold that summarizes a FunctionDef as
// pure or impure. Reads per-expression `pureEffect` hints produced by
// `PurityEffectAnalysis`, layers on scope-level structural rules
// (Assign target must be local; no nested FunctionDef / Global /
// NonLocal; self-recursive Call exempt from expression-level impurity),
// and writes `pure: boolean` on the FunctionDef's own hint.
//
// `MemoizationTransformRule.matches` reads `hint.pure === true` as its
// purity gate. FileInput units are skipped (the top-level scope is
// never a memoization callee).

import { ExprNS, StmtNS } from "../../ast-types";
import type { FunctionUnit } from "../framework/function-unit";
import type { OptimizationHint } from "../framework/hint";
import type { ScopePass } from "../framework/interfaces";
import { PURE, PURE_EFFECT_FIELD, type PureEffect } from "./purity-effect";

/** Hint field written by this pass. */
export const PURE_FIELD = "pure";

export class PurityScopePass implements ScopePass {
  readonly name = "purity";

  run(unit: FunctionUnit): void {
    const fd = unit.funcAst;
    if (!(fd instanceof StmtNS.FunctionDef)) return;
    const self = fd.name.lexeme;
    const locals = collectLocals(fd);

    const pure = stmtsArePure(fd.body, self, locals, unit);

    const prev = unit.hints.get(fd) ?? {};
    if (prev[PURE_FIELD] === pure) return;
    const nextHint: OptimizationHint = { ...prev, [PURE_FIELD]: pure };
    unit.hints.set(fd, nextHint);
  }
}

/**
 * Collect every name bound inside `fd`'s body: parameters, `fd.varDecls`
 * (populated by the parser for some scopes), and the LHS of every
 * Assign/AnnAssign/For target reachable through non-class blocks. The
 * resolver declares these via `environment.declareName`, but that
 * information isn't mirrored back onto the AST, so we recover it here
 * with a single structural walk. Nested FunctionDef bodies are skipped
 * (they're their own scope).
 */
function collectLocals(fd: StmtNS.FunctionDef): Set<string> {
  const locals = new Set<string>(fd.parameters.map(p => p.lexeme));
  for (const tok of fd.varDecls) locals.add(tok.lexeme);
  collectAssignedNames(fd.body, locals);
  return locals;
}

function collectAssignedNames(stmts: StmtNS.Stmt[], out: Set<string>): void {
  for (const s of stmts) {
    if (s instanceof StmtNS.Assign || s instanceof StmtNS.AnnAssign) {
      if (s.target instanceof ExprNS.Variable) out.add(s.target.name.lexeme);
    } else if (s instanceof StmtNS.For) {
      out.add(s.target.lexeme);
      collectAssignedNames(s.body, out);
    } else if (s instanceof StmtNS.If) {
      collectAssignedNames(s.body, out);
      if (s.elseBlock) collectAssignedNames(s.elseBlock, out);
    } else if (s instanceof StmtNS.While) {
      collectAssignedNames(s.body, out);
    }
    // FunctionDef: own scope, skip.
  }
}

function stmtsArePure(
  stmts: StmtNS.Stmt[],
  self: string,
  locals: Set<string>,
  unit: FunctionUnit,
): boolean {
  for (const s of stmts) {
    if (!stmtIsPure(s, self, locals, unit)) return false;
  }
  return true;
}

function stmtIsPure(
  stmt: StmtNS.Stmt,
  self: string,
  locals: Set<string>,
  unit: FunctionUnit,
): boolean {
  if (stmt instanceof StmtNS.Pass) return true;
  if (stmt instanceof StmtNS.Break) return true;
  if (stmt instanceof StmtNS.Continue) return true;
  if (stmt instanceof StmtNS.Return) {
    return stmt.value === null || exprIsPureWithSelf(stmt.value, self, locals, unit);
  }
  if (stmt instanceof StmtNS.Assign || stmt instanceof StmtNS.AnnAssign) {
    // Target must be a bare local Variable; subscript assignment is impure.
    if (!(stmt.target instanceof ExprNS.Variable)) return false;
    if (!locals.has(stmt.target.name.lexeme)) return false;
    return exprIsPureWithSelf(stmt.value, self, locals, unit);
  }
  if (stmt instanceof StmtNS.If) {
    if (!exprIsPureWithSelf(stmt.condition, self, locals, unit)) return false;
    if (!stmtsArePure(stmt.body, self, locals, unit)) return false;
    if (stmt.elseBlock && !stmtsArePure(stmt.elseBlock, self, locals, unit)) return false;
    return true;
  }
  if (stmt instanceof StmtNS.While) {
    return (
      exprIsPureWithSelf(stmt.condition, self, locals, unit) &&
      stmtsArePure(stmt.body, self, locals, unit)
    );
  }
  if (stmt instanceof StmtNS.For) {
    return (
      exprIsPureWithSelf(stmt.iter, self, locals, unit) &&
      stmtsArePure(stmt.body, self, locals, unit)
    );
  }
  // FunctionDef (nested), Global, NonLocal, FromImport, SimpleExpr,
  // Assert, FileInput — unsupported in a pure function body.
  return false;
}

/**
 * Read the expression-level `pureEffect` mark produced by
 * PurityEffectAnalysis, with a scope-level exemption: a Call to `self` is
 * treated as pure iff all its arguments are pure (self-recursion).
 */
function exprIsPureWithSelf(
  expr: ExprNS.Expr,
  self: string,
  locals: Set<string>,
  unit: FunctionUnit,
): boolean {
  if (expr instanceof ExprNS.Call) {
    if (!(expr.callee instanceof ExprNS.Variable)) return false;
    if (expr.callee.name.lexeme !== self) return false;
    for (const a of expr.args) {
      if (!exprIsPureWithSelf(a, self, locals, unit)) return false;
    }
    return true;
  }
  const hint = unit.hints.get(expr);
  const effect = hint?.[PURE_EFFECT_FIELD] as PureEffect | undefined;
  // Missing mark = impure (safe default). Happens only when
  // PurityEffectAnalysis is not registered alongside this ScopePass —
  // callers must wire both for a functioning purity gate.
  return effect === PURE;
}
