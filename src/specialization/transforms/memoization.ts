import { StmtNS, ExprNS } from "../../ast-types";
import type { Unit } from "../framework/function-unit";
import type { Reading, TransformRule, TransformFactView } from "../framework/analysis";
import { runtimeCallAnalysis, RUNTIME_CALL_COUNT_SAT } from "../framework/runtime-analyses";
import { purityScopeAnalysis } from "../purity-analysis/analysis";
import { guardKeyFromGuards, directParamEntryGuardsFor } from "../entry-guards";

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

function shadowStmt<T extends StmtNS.Stmt>(orig: T, patch: Partial<T>): T {
  const shadow = Object.create(Object.getPrototypeOf(orig)) as T;
  Object.assign(shadow, orig, patch);
  return shadow;
}

export function memoIdFor(fd: StmtNS.FunctionDef, variant?: string): string {
  const base = `${fd.name.lexeme}@L${fd.name.line}`;
  return variant === undefined ? base : `${base}#${variant}`;
}

function rewriteReturnsCloned(
  stmts: readonly StmtNS.Stmt[],
  fd: StmtNS.FunctionDef,
  id: string,
  params: readonly ExprNS.Variable[],
): readonly StmtNS.Stmt[] {
  let changed = false;
  const out: StmtNS.Stmt[] = [];
  for (const s of stmts) {
    if (s instanceof StmtNS.Return) {
      if (s.value !== null) {
        changed = true;
        const args: ExprNS.Expr[] = [
          mkStr(fd, id),
          ...params.map(p => new ExprNS.Variable(p.startToken, p.endToken, p.name)),
          s.value,
        ];
        out.push(shadowStmt(s, { value: mkCall(fd, MEMO_PUT, args) }));
      } else {
        out.push(s);
      }
    } else if (s instanceof StmtNS.If) {
      const body = rewriteReturnsCloned(s.body, fd, id, params);
      const elseBlock = s.elseBlock ? rewriteReturnsCloned(s.elseBlock, fd, id, params) : s.elseBlock;
      if (body !== s.body || elseBlock !== s.elseBlock) {
        changed = true;
        out.push(shadowStmt(s, {
          body: body as StmtNS.Stmt[],
          elseBlock: elseBlock as StmtNS.Stmt[] | null,
        }));
      } else {
        out.push(s);
      }
    } else if (s instanceof StmtNS.While || s instanceof StmtNS.For) {
      const body = rewriteReturnsCloned(s.body, fd, id, params);
      if (body !== s.body) {
        changed = true;
        out.push(shadowStmt(s, { body: body as StmtNS.Stmt[] }));
      } else {
        out.push(s);
      }
    } else {
      out.push(s);
    }
  }
  return changed ? out : stmts;
}

export function memoWrappedBody(
  fd: StmtNS.FunctionDef,
  body: readonly StmtNS.Stmt[],
  variant?: string,
): readonly StmtNS.Stmt[] {
  const id = memoIdFor(fd, variant);
  const params = fd.parameters.map(p => mkVar(fd, p.lexeme));

  const hasCall = mkCall(fd, MEMO_HAS, [mkStr(fd, id), ...params]);
  const getCall = mkCall(fd, MEMO_GET, [mkStr(fd, id), ...params.map(p => new ExprNS.Variable(p.startToken, p.endToken, p.name))]);
  const prelude = new StmtNS.If(
    fd.startToken,
    fd.endToken,
    hasCall,
    [new StmtNS.Return(fd.startToken, fd.endToken, getCall)],
    null,
  );

  return [prelude, ...rewriteReturnsCloned(body, fd, id, params)];
}

export function memoizationWitnessFor(
  fd: StmtNS.FunctionDef,
  facts: TransformFactView,
): Reading<true> | undefined {
  return facts.readMinimal(purityScopeAnalysis, fd.id, value => value === true) as Reading<true> | undefined;
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


/** True iff `body`'s first statement is the memo-check prelude. Used to
 *  short-circuit re-firing once the rewrite has landed at a given witness
 *  — same shape-idempotence pattern as dead-branch / const-fold. */
function bodyHasMemoPrelude(body: readonly StmtNS.Stmt[]): boolean {
  const first = body[0];
  if (!(first instanceof StmtNS.If)) return false;
  const cond = first.condition;
  if (!(cond instanceof ExprNS.Call)) return false;
  const callee = cond.callee;
  return callee instanceof ExprNS.Variable && callee.name.lexeme === MEMO_HAS;
}

// Shape-idempotent: once the body at the winning witness opens with the
// memo prelude, re-sweeps at descendant contexts see the prelude via
// ancestor-walk and short-circuit. Publication sink is the witness's
// forked body (ROOT's body is `unit.funcAst.body`, so ROOT witnesses still
// mutate shared AST — no special case).
export const memoizationRule: TransformRule = {
  id: Symbol("memoizationRule"),
  debugName: "memoizationRule",
  edges: [
    { on: "fact", analysis: runtimeCallAnalysis, wake: (ctx, functionId) => {
      const u = ctx.topology.unitOfFunctionId(functionId as number);
      return u ? [u] : [];
    }},
    { on: "fact", analysis: purityScopeAnalysis, wake: (ctx, functionId) => {
      const u = ctx.topology.unitOfFunctionId(functionId as number);
      return u ? [u] : [];
    }},
  ],
  sweep(unit: Unit, facts: TransformFactView): boolean {
    const fd = unit.funcAst;
    if (!(fd instanceof StmtNS.FunctionDef)) return false;
    // runtimeCallAnalysis already saturates at RUNTIME_CALL_COUNT_SAT via its
    // lattice join, so readProfitability returns the capped count directly.
    if (facts.readProfitability(runtimeCallAnalysis, fd.id) < MEMOIZATION_THRESHOLD) return false;
    const witness = memoizationWitnessFor(fd, facts);
    if (witness === undefined) return false;
    const body = facts.bodyAtWitness(unit, witness);
    if (bodyHasMemoPrelude(body)) return false;
    // Memo variant identity derives from the witness context, so sibling
    // contexts that readMinimal the same witness converge on the same
    // memo table.
    const variant = guardKeyFromGuards(directParamEntryGuardsFor(unit, witness.witness));
    const rewritten = memoWrappedBody(fd, body, variant);
    // In-place replacement of the body's contents. The array identity is
    // preserved so descendant chain nodes that inherit via bodyFor walk
    // still see the rewrite.
    body.length = 0;
    body.push(...rewritten);
    return true;
  },
};
