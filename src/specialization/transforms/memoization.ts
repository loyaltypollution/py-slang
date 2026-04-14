import { StmtNS, ExprNS } from "../../ast-types";
import type { FactStore } from "../framework/fact-store";
import type { FunctionUnit } from "../framework/function-unit";
import type { PassCtx, TransformRule } from "../framework/pass";
import { runtimeCallPass, RUNTIME_CALL_COUNT_SAT } from "../framework/runtime-passes";
import { purityScopePass } from "../purity-analysis/analysis";

export const MEMOIZATION_THRESHOLD = RUNTIME_CALL_COUNT_SAT - 1;
import { Token } from "../../tokenizer/tokenizer";
import { TokenType } from "../../tokens";
import { MEMO_INTRINSIC_NAMES } from "../../runtime/memo";

const [MEMO_HAS, MEMO_GET, MEMO_PUT] = MEMO_INTRINSIC_NAMES;

/** True if `fd.body` already opens with the memo-check prelude this rule
 *  emits. Makes the transform shape-idempotent: once the prelude is present,
 *  the precondition for rewriting is no longer met and `sweep` returns false
 *  without external bookkeeping. */
function hasMemoPrelude(fd: StmtNS.FunctionDef): boolean {
  const first = fd.body[0];
  if (!(first instanceof StmtNS.If)) return false;
  const cond = first.condition;
  if (!(cond instanceof ExprNS.Call)) return false;
  const callee = cond.callee;
  return callee instanceof ExprNS.Variable && callee.name.lexeme === MEMO_HAS;
}

function applyMemoizationWrap(unit: FunctionUnit): boolean {
  const fd = unit.funcAst;
  if (!(fd instanceof StmtNS.FunctionDef)) return false;

  const id = `${fd.name.lexeme}@L${fd.name.line}`;
  const params = fd.parameters.map(p => mkVar(fd, p.lexeme));

  const hasCall = mkCall(fd, MEMO_HAS, [mkStr(fd, id), ...params]);
  // Fresh Variable nodes (new ids) reusing name Tokens — AST hint lookups
  // key on node identity, so the args cannot alias the `params` array above.
  const getCall = mkCall(fd, MEMO_GET, [mkStr(fd, id), ...params.map(p => new ExprNS.Variable(p.startToken, p.endToken, p.name))]);
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

function mkTok(fd: StmtNS.FunctionDef, type: TokenType, lexeme: string): Token {
  return new Token(type, lexeme, fd.name.line, fd.name.col, fd.name.indexInSource);
}

function mkVar(fd: StmtNS.FunctionDef, name: string): ExprNS.Variable {
  const tok = mkTok(fd, TokenType.NAME, name);
  return new ExprNS.Variable(tok, tok, tok);
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
        const args: ExprNS.Expr[] = [mkStr(fd, id), ...params.map(p => new ExprNS.Variable(p.startToken, p.endToken, p.name)), s.value];
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

// Shape-idempotent: once the body opens with the memo prelude, the
// precondition fails and the sweep returns false. Matches the idempotency
// model used by dead-branch and const-fold — no external wrapped-set needed.
export const memoizationRule: TransformRule = {
  id: Symbol("memoizationRule"),
  debugName: "memoizationRule",
  edges: [
    { on: "fact", pass: runtimeCallPass, wake: (ctx, fdId) => {
      const u = ctx.unitForFdId(fdId as number);
      return u ? [u] : [];
    }},
    { on: "fact", pass: purityScopePass, wake: (ctx, fdId) => {
      const u = ctx.unitForFdId(fdId as number);
      return u ? [u] : [];
    }},
  ],
  sweep(unit: FunctionUnit, factStore: FactStore, _ctx: PassCtx): boolean {
    const fd = unit.funcAst;
    if (!(fd instanceof StmtNS.FunctionDef)) return false;
    if (hasMemoPrelude(fd)) return false;
    // runtimeCallPass already saturates at RUNTIME_CALL_COUNT_SAT via its
    // lattice join, so factStore.read returns the capped count directly.
    if (factStore.read(runtimeCallPass, fd.id) < MEMOIZATION_THRESHOLD) return false;
    if (factStore.read(purityScopePass, fd.id) !== true) return false;
    return applyMemoizationWrap(unit);
  },
};
