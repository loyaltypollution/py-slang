// In-place memoize wrap for tree-walking engines (CSE) that hold live
// references to AST nodes via Closure.node and cannot swap to a rewritten
// AST. The pure counterpart `rewriteMemoize` in `pure-rewrites.ts` remains
// the canonical form for SVML's compile pipeline; this mutating variant
// exists because Closure dispatch in CSE has no indirection layer.
//
// Idempotent via a WeakSet of already-wrapped FunctionDef nodes supplied
// by the caller (typically scoped to one evaluateChunk).
//
// Calls in flight against the mutated FunctionDef are safe: the CSE
// interpreter has already popped old body statements onto its control
// stack and will finish them normally. The NEXT call to the closure walks
// `fd.body` fresh and sees the prepended prelude / rewritten returns.

import { ExprNS, StmtNS } from "../../ast-types";
import { Token } from "../../tokenizer/tokenizer";
import { TokenType } from "../../tokens";
import { MEMO_INTRINSIC_NAMES } from "../../runtime/memo";

const [MEMO_HAS, MEMO_GET, MEMO_PUT] = MEMO_INTRINSIC_NAMES;

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

function rewriteReturnsInPlace(
  stmts: StmtNS.Stmt[],
  fd: StmtNS.FunctionDef,
  id: string,
  paramNames: readonly string[],
): void {
  for (const s of stmts) {
    if (s instanceof StmtNS.Return) {
      if (s.value !== null) {
        const args: ExprNS.Expr[] = [
          mkStr(fd, id),
          ...paramNames.map((n) => mkVar(fd, n)),
          s.value,
        ];
        s.value = mkCall(fd, MEMO_PUT, args);
      }
    } else if (s instanceof StmtNS.If) {
      rewriteReturnsInPlace(s.body, fd, id, paramNames);
      if (s.elseBlock !== null) rewriteReturnsInPlace(s.elseBlock, fd, id, paramNames);
    } else if (s instanceof StmtNS.While || s instanceof StmtNS.For) {
      rewriteReturnsInPlace(s.body, fd, id, paramNames);
    }
    // Nested FunctionDef: a separate scope; its own unit handles it.
  }
}

export function applyMemoizeInPlace(
  fd: StmtNS.FunctionDef,
  applied: WeakSet<StmtNS.FunctionDef>,
): boolean {
  if (applied.has(fd)) return false;
  applied.add(fd);

  const id = `${fd.name.lexeme}@L${fd.name.line}`;
  const paramNames = fd.parameters.map((p) => p.lexeme);

  const hasCall = mkCall(fd, MEMO_HAS, [mkStr(fd, id), ...paramNames.map((n) => mkVar(fd, n))]);
  const getCall = mkCall(fd, MEMO_GET, [mkStr(fd, id), ...paramNames.map((n) => mkVar(fd, n))]);
  const prelude = new StmtNS.If(
    fd.startToken,
    fd.endToken,
    hasCall,
    [new StmtNS.Return(fd.startToken, fd.endToken, getCall)],
    null,
  );

  rewriteReturnsInPlace(fd.body, fd, id, paramNames);
  fd.body.unshift(prelude);
  return true;
}
