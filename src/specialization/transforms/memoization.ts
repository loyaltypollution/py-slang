// src/specialization/transforms/memoization.ts
//
// MemoizationTransformRule — wraps a hot, pure FunctionDef with a runtime
// cache by mutating its body in place. Scope-level rule: matches when the
// unit *is* a FunctionDef whose hint carries a callCount ≥ threshold and
// whose body passes the syntactic purity check. The unit's own transform
// queue is re-enqueued every time the worklist rebuilds the scope after an
// observeCall, so the rule fires on the next tick after threshold is hit.
//
// Relies on three runtime intrinsics registered by the interpreter:
//
//     __memo_has(id, *args) -> bool
//     __memo_get(id, *args) -> cached value
//     __memo_put(id, *args, value) -> value       (returns the stored value)
//
// Wrap shape (for `def f(x)` at line 1 with id = "f@L1"):
//
//     def f(x):
//         if __memo_has("f@L1", x):
//             return __memo_get("f@L1", x)
//         # original body, with each `return E` rewritten to
//         # `return __memo_put("f@L1", x, E)`
//
// No new scopes are introduced (Gap 5 respected).

import { ExprNS, StmtNS } from "../../ast-types";
import type { FunctionUnit } from "../framework/function-unit";
import { Token } from "../../tokenizer/tokenizer";
import { TokenType } from "../../tokens";

import { MEMO_INTRINSIC_NAMES } from "../../runtime/memo";

const [MEMO_HAS, MEMO_GET, MEMO_PUT] = MEMO_INTRINSIC_NAMES;

/**
 * Wrap `unit`'s FunctionDef body with the memoization prelude in place.
 * Returns `true` iff the body was mutated. Caller gates on threshold +
 * purity; this helper only handles the rewrite.
 */
export function applyMemoizationWrap(unit: FunctionUnit): boolean {
  const fd = unit.funcAst;
  if (!(fd instanceof StmtNS.FunctionDef)) return false;
  // Idempotence: re-invocation on an already-wrapped body must be a no-op.
  // Transfer mutates AST eagerly; the lattice "fired" write gates dispatch
  // fan-out but the side effect happens before any equality check. Detect
  // the prelude by shape: an `If` whose condition is a Call to MEMO_HAS.
  if (isAlreadyWrapped(fd.body)) return false;

  const id = mintId(fd);
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

// ── AST construction helpers ────────────────────────────────────────────────

function mintId(fd: StmtNS.FunctionDef): string {
  return `${fd.name.lexeme}@L${fd.name.line}`;
}

function mkTok(fd: StmtNS.FunctionDef, type: TokenType, lexeme: string): Token {
  return new Token(type, lexeme, fd.name.line, fd.name.col, fd.name.indexInSource);
}

function mkVar(fd: StmtNS.FunctionDef, name: string): ExprNS.Variable {
  const tok = mkTok(fd, TokenType.NAME, name);
  return new ExprNS.Variable(tok, tok, tok);
}

function cloneVar(v: ExprNS.Variable): ExprNS.Variable {
  // Fresh node (new id) reusing the name Token. AST hint lookups key on
  // node identity, so we never share an expression node across call sites.
  return new ExprNS.Variable(v.startToken, v.endToken, v.name);
}

function mkStr(fd: StmtNS.FunctionDef, s: string): ExprNS.Literal {
  const tok = mkTok(fd, TokenType.STRING, JSON.stringify(s));
  return new ExprNS.Literal(tok, tok, s);
}

function mkCall(fd: StmtNS.FunctionDef, fn: string, args: ExprNS.Expr[]): ExprNS.Call {
  return new ExprNS.Call(fd.startToken, fd.endToken, mkVar(fd, fn), args);
}

// ── Return rewriting ────────────────────────────────────────────────────────

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
    // FunctionDef (nested), Assign, Pass, etc. — do not descend.
  }
}
