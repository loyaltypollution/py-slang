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
import type { Token } from "../../tokenizer";
import type { FunctionUnit } from "../framework/function-unit";
import type { OptimizationHint } from "../framework/hint";
import type { ScopePass } from "../framework/interfaces";
import { PURE, PURE_EFFECT_FIELD } from "./purity-effect";

/** Hint field written by this pass. */
export const PURE_FIELD = "pure";

export class PurityScopePass implements ScopePass {
  readonly name = "purity";

  run(unit: FunctionUnit): void {
    const fd = unit.funcAst;
    if (!(fd instanceof StmtNS.FunctionDef)) return;
    const self = fd.name.lexeme;
    const pure = stmtsArePure(fd.body, self, unit);

    const prev = unit.hints.get(fd) ?? {};
    if (prev[PURE_FIELD] === pure) return;
    const nextHint: OptimizationHint = { ...prev, [PURE_FIELD]: pure };
    unit.hints.set(fd, nextHint);
  }
}

function stmtsArePure(stmts: StmtNS.Stmt[], self: string, unit: FunctionUnit): boolean {
  for (const s of stmts) {
    if (!stmtIsPure(s, self, unit)) return false;
  }
  return true;
}

/** A name binds to a slot that is frame-local (envLevel === 0, not primitive). */
function isLocalName(unit: FunctionUnit, token: Token): boolean {
  const info = unit.slotLookup(token);
  return !info.isPrimitive && info.envLevel === 0;
}

function stmtIsPure(stmt: StmtNS.Stmt, self: string, unit: FunctionUnit): boolean {
  if (stmt instanceof StmtNS.Pass) return true;
  if (stmt instanceof StmtNS.Break) return true;
  if (stmt instanceof StmtNS.Continue) return true;
  if (stmt instanceof StmtNS.Return) {
    return stmt.value === null || exprIsPureWithSelf(stmt.value, self, unit);
  }
  if (stmt instanceof StmtNS.Assign || stmt instanceof StmtNS.AnnAssign) {
    // Target must be a frame-local bare Variable; subscript / non-local
    // targets are impure.
    if (!(stmt.target instanceof ExprNS.Variable)) return false;
    if (!isLocalName(unit, stmt.target.name)) return false;
    return exprIsPureWithSelf(stmt.value, self, unit);
  }
  if (stmt instanceof StmtNS.If) {
    if (!exprIsPureWithSelf(stmt.condition, self, unit)) return false;
    if (!stmtsArePure(stmt.body, self, unit)) return false;
    if (stmt.elseBlock && !stmtsArePure(stmt.elseBlock, self, unit)) return false;
    return true;
  }
  if (stmt instanceof StmtNS.While) {
    return exprIsPureWithSelf(stmt.condition, self, unit) && stmtsArePure(stmt.body, self, unit);
  }
  if (stmt instanceof StmtNS.For) {
    if (!isLocalName(unit, stmt.target)) return false;
    return exprIsPureWithSelf(stmt.iter, self, unit) && stmtsArePure(stmt.body, self, unit);
  }
  // FunctionDef (nested), Global, NonLocal, FromImport, SimpleExpr,
  // Assert, FileInput — unsupported in a pure function body.
  return false;
}

/**
 * Read the expression-level `pureEffect` mark produced by
 * PurityEffectAnalysis, with a scope-level exemption: a Call to `self`
 * with pure arguments is treated as pure (self-recursion).
 */
function exprIsPureWithSelf(expr: ExprNS.Expr, self: string, unit: FunctionUnit): boolean {
  if (
    expr instanceof ExprNS.Call &&
    expr.callee instanceof ExprNS.Variable &&
    expr.callee.name.lexeme === self
  ) {
    return expr.args.every(a => exprIsPureWithSelf(a, self, unit));
  }
  // Missing mark = impure (safe default). Happens only when
  // PurityEffectAnalysis is not registered alongside this ScopePass.
  return unit.hints.get(expr)?.[PURE_EFFECT_FIELD] === PURE;
}
