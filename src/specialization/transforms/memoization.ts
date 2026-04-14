// Memoization: wraps a hot, pure FunctionDef body using __memo_has / __memo_get / __memo_put.

import { ExprNS, StmtNS } from "../../ast-types";
import type { FunctionUnit } from "../framework/function-unit";
import type { Pass, PassCtx } from "../framework/pass";
import { structuralPass } from "../framework/structural-pass";
import { firedLattice, type Fired } from "../framework/transform-rule";
import { callCountPass, MEMOIZATION_THRESHOLD } from "../memoization-analysis/call-count";
import { purityScopePass } from "../purity-analysis/analysis";
import { Token } from "../../tokenizer/tokenizer";
import { TokenType } from "../../tokens";

import { MEMO_INTRINSIC_NAMES } from "../../runtime/memo";

const [MEMO_HAS, MEMO_GET, MEMO_PUT] = MEMO_INTRINSIC_NAMES;

// Idempotent: returns false if the prelude is already present.
function applyMemoizationWrap(unit: FunctionUnit): boolean {
  const fd = unit.funcAst;
  if (!(fd instanceof StmtNS.FunctionDef)) return false;
  if (isAlreadyWrapped(fd.body)) return false;

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

function isAlreadyWrapped(body: StmtNS.Stmt[]): boolean {
  if (body.length === 0) return false;
  const first = body[0];
  if (!(first instanceof StmtNS.If)) return false;
  const cond = first.condition;
  if (!(cond instanceof ExprNS.Call)) return false;
  const callee = cond.callee;
  return callee instanceof ExprNS.Variable && callee.name.lexeme === MEMO_HAS;
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
export const memoizationRule: Pass<FunctionUnit, Fired> = {
  id: Symbol("memoizationRule"),
  debugName: "memoizationRule",
  lattice: firedLattice,
  reads: [callCountPass, purityScopePass, structuralPass],
  tier: "transform",
  affectedKeys(ctx, triggerPass, triggerKey) {
    if (triggerPass === (structuralPass as Pass<any, any>)) {
      return [triggerKey as FunctionUnit];
    }
    const fdId = triggerKey as number;
    const unit = ctx.unitForFdId(fdId);
    return unit === undefined ? [] : [unit];
  },
  // No `prune`: one-shot — pruning would self-trigger via structuralPass.
  transfer(ctx: PassCtx, key: FunctionUnit): Fired {
    const fd = key.funcAst;
    if (!(fd instanceof StmtNS.FunctionDef)) return undefined;
    const count = ctx.read(callCountPass, fd.id);
    if (count < MEMOIZATION_THRESHOLD) return undefined;
    if (ctx.read(purityScopePass, fd.id) !== true) return undefined;
    if (!applyMemoizationWrap(key)) return undefined;
    return "fired";
  },
};
