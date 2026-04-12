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
import type { ScopeTransformRule } from "../framework/interfaces";
import type { FunctionUnit } from "../framework/function-unit";
import type { OptimizationHint } from "../framework/hint";
import {
  CALL_COUNT_FIELD,
  MEMOIZATION_THRESHOLD,
  MEMOIZED_FIELD,
} from "../memoization-analysis/analysis";
import { isPureFunctionDef } from "../memoization-analysis/purity";
import { Token } from "../../tokenizer/tokenizer";
import { TokenType } from "../../tokens";

import { MEMO_INTRINSIC_NAMES } from "../../runtime/memo";

const [MEMO_HAS, MEMO_GET, MEMO_PUT] = MEMO_INTRINSIC_NAMES;

export class MemoizationTransformRule implements ScopeTransformRule {
  readonly name = "memoization";
  readonly level = "scope" as const;
  // Mutation only affects future calls: the interpreter copies `fd.body` at
  // call time, so prepending the cache-check prelude and rewriting `return E`
  // to `return __memo_put(id, *args, E)` doesn't disturb on-stack frames.
  // Without this, fib never memoizes during a single execution (it stays
  // pinned all the way to the outermost return).
  readonly safeOnStack = true;
  // Non-monotone rule: without one-shot scheduling, `matches` would re-fire
  // after a successful apply (there is no lattice fact that `apply`
  // "raises" to block its own predicate). The scheduler's `fireOnce`
  // bookkeeping records `(scope, rule)` after the first success; the rule
  // itself carries no self-latch.
  readonly fireOnce = true;

  matches(unit: FunctionUnit): boolean {
    const fd = unit.funcAst;
    if (!(fd instanceof StmtNS.FunctionDef)) return false;
    const hint = unit.hints.get(fd);
    if (!hint) return false;
    const count = typeof hint[CALL_COUNT_FIELD] === "number" ? (hint[CALL_COUNT_FIELD] as number) : 0;
    if (count < MEMOIZATION_THRESHOLD) return false;
    return isPureFunctionDef(fd);
  }

  apply(unit: FunctionUnit): boolean {
    const fd = unit.funcAst as StmtNS.FunctionDef;
    const id = mintId(fd);
    const params = fd.parameters.map(p => mkVar(fd, p.lexeme));

    // Prelude: `if __memo_has(id, *params): return __memo_get(id, *params)`.
    const hasCall = mkCall(fd, MEMO_HAS, [mkStr(fd, id), ...params]);
    const getCall = mkCall(fd, MEMO_GET, [mkStr(fd, id), ...params.map(p => cloneVar(p))]);
    const prelude = new StmtNS.If(
      fd.startToken,
      fd.endToken,
      hasCall,
      [new StmtNS.Return(fd.startToken, fd.endToken, getCall)],
      null,
    );

    // Rewrite every `return E` in the body to `return __memo_put(id, *params, E)`,
    // skipping nested FunctionDef / class scopes so inner functions aren't
    // entangled with the outer cache.
    rewriteReturns(fd.body, fd, id, params);

    // Splice the prelude as the first statement.
    fd.body.unshift(prelude);

    // Annotate the FunctionDef so external consumers (tests,
    // introspection) can detect that memoization fired on this scope.
    // The re-fire guard is provided by the scheduler's `fireOnce`
    // bookkeeping (this rule sets `fireOnce = true`), not by this
    // hint — `matches()` no longer reads it.
    const prev = unit.hints.get(fd) ?? {};
    const nextHint: OptimizationHint = { ...prev, [MEMOIZED_FIELD]: true };
    unit.hints.set(fd, nextHint);

    return true;
  }
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
