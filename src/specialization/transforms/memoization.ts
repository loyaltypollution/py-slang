// Memoization: wraps a hot, pure FunctionDef body using __memo_has / __memo_get / __memo_put.

import { StmtNS, ExprNS } from "../../ast-types";
import type { FunctionUnit } from "../framework/function-unit";
import type { Pass, PassCtx } from "../framework/pass";
import { structuralPass } from "../framework/structural-pass";
import { firedLattice, type Fired } from "../framework/transform-rule";
import { callCountPass, MEMOIZATION_THRESHOLD } from "../memoization-analysis/call-count";
import { purityScopePass } from "../purity-analysis/analysis";
import { Token } from "../../tokenizer/tokenizer";
import { TokenType } from "../../tokens";
import { MEMO_INTRINSIC_NAMES } from "../../runtime/memo";

function fdIdToUnit(ctx: PassCtx, key: unknown): Iterable<FunctionUnit> {
  const unit = ctx.unitForFdId(key as number);
  return unit === undefined ? [] : [unit];
}

const [MEMO_HAS, MEMO_GET, MEMO_PUT] = MEMO_INTRINSIC_NAMES;

// Idempotency is enforced by the caller gating on the `firedLattice` cell;
// the cell is top-only with no `prune`, so it stays "fired" across structural
// rebuilds — a single source of truth replacing the previous
// `FunctionUnit.memoizationApplied` duplicate flag.
function applyMemoizationWrap(unit: FunctionUnit): boolean {
  const fd = unit.funcAst;
  if (!(fd instanceof StmtNS.FunctionDef)) return false;

  const id = `${fd.name.lexeme}@L${fd.name.line}`;
  const params = fd.parameters.map(p => mkVar(fd, p.lexeme));

  const hasCall = mkCall(fd, MEMO_HAS, [mkStr(fd, id), ...params]);
  const getCall = mkCall(fd, MEMO_GET, [mkStr(fd, id), ...params.map(p => cloneVar(p))]);
  const prelude = new StmtNS.If(
    fd.startToken,
    fd.endToken,
    hasCall,
    [new StmtNS.Return(fd.startToken, fd.endToken, getCall)],
    null,
  );

  rewriteReturns(fd.body, fd, id, params);
  fd.body.unshift(prelude);
  return true;
}

// AST construction helpers

function mkTok(fd: StmtNS.FunctionDef, type: TokenType, lexeme: string): Token {
  return new Token(type, lexeme, fd.name.line, fd.name.col, fd.name.indexInSource);
}

function mkVar(fd: StmtNS.FunctionDef, name: string): ExprNS.Variable {
  const tok = mkTok(fd, TokenType.NAME, name);
  return new ExprNS.Variable(tok, tok, tok);
}

// Fresh node (new id) reusing the name Token — AST hint lookups key on node identity.
function cloneVar(v: ExprNS.Variable): ExprNS.Variable {
  return new ExprNS.Variable(v.startToken, v.endToken, v.name);
}

function mkStr(fd: StmtNS.FunctionDef, s: string): ExprNS.Literal {
  const tok = mkTok(fd, TokenType.STRING, JSON.stringify(s));
  return new ExprNS.Literal(tok, tok, s);
}

function mkCall(fd: StmtNS.FunctionDef, fn: string, args: ExprNS.Expr[]): ExprNS.Call {
  return new ExprNS.Call(fd.startToken, fd.endToken, mkVar(fd, fn), args);
}


function rewriteReturns(
  stmts: StmtNS.Stmt[],
  fd: StmtNS.FunctionDef,
  id: string,
  params: readonly ExprNS.Variable[],
): void {
  for (const s of stmts) {
    if (s instanceof StmtNS.Return) {
      if (s.value !== null) {
        const args: ExprNS.Expr[] = [mkStr(fd, id), ...params.map(p => cloneVar(p)), s.value];
        s.value = mkCall(fd, MEMO_PUT, args);
      }
    } else if (s instanceof StmtNS.If) {
      rewriteReturns(s.body, fd, id, params);
      if (s.elseBlock) rewriteReturns(s.elseBlock, fd, id, params);
    } else if (s instanceof StmtNS.While || s instanceof StmtNS.For) {
      rewriteReturns(s.body, fd, id, params);
    }
    // Nested FunctionDef / Assign / Pass / etc. — do not descend.
  }
}

// Gated on callCount threshold and purity. Keyed by FunctionDef.id via structuralPass.
// One-shot per unit: the `firedLattice` cell (top-only, no prune) is both the
// idempotency gate and the observable "memoization fired" signal. Reacting to
// `callCountPass` / `purityScopePass` writes requires a custom `affectedKeys`
// (the stock `unitSweepRule` only wakes on `structuralPass`).
export const memoizationRule: Pass<FunctionUnit, Fired> = {
  id: Symbol("memoizationRule"),
  debugName: "memoizationRule",
  lattice: firedLattice,
  reads: [
    { pass: structuralPass, project: (_ctx, key) => [key as FunctionUnit] },
    { pass: callCountPass, project: fdIdToUnit },
    { pass: purityScopePass, project: fdIdToUnit },
  ],
  tier: "transform",
  // No `prune`: one-shot — pruning would self-trigger via structuralPass.
  transfer(ctx: PassCtx, key: FunctionUnit): Fired {
    // Idempotency gate: if this cell is already "fired", do not re-wrap.
    // Replaces the old `unit.memoizationApplied` flag — the cell is the
    // single source of truth, top-only + no-prune = sticky one-shot.
    if (ctx.tryRead(memoizationRule, key) === "fired") return undefined;
    const fd = key.funcAst;
    if (!(fd instanceof StmtNS.FunctionDef)) return undefined;
    const count = ctx.read(callCountPass, fd.id);
    if (count < MEMOIZATION_THRESHOLD) return undefined;
    if (ctx.read(purityScopePass, fd.id) !== true) return undefined;
    if (!applyMemoizationWrap(key)) return undefined;
    return "fired";
  },
};
