import { ExprNS, StmtNS } from "../../ast-types";
import { clearMemoId, MEMO_INTRINSIC_NAMES } from "../../runtime/memo";
import { Token } from "../../tokenizer/tokenizer";
import { TokenType } from "../../tokenizer";
import { directParamEntryGuardsFor, guardKeyFromGuards } from "../narrowing-policy/entry-guards";
import type { TransformRule } from "../framework/analysis";
import { shadowNode } from "../framework/variant-body-clone";
import { type AssumptionChain } from "../assumption";
import { forkBody } from "../speculation/assumption-bodies";
import type { Function } from "../program/views/function";
import { runtimeCallCounter } from "../observation/runtime-analyses";
import type { FunctionLocator } from "../program/views/function-locator";
import { purityFunctionAnalysis } from "../analysis";

const [MEMO_HAS, MEMO_GET, MEMO_PUT] = MEMO_INTRINSIC_NAMES;

export function memoIdFor(fd: StmtNS.FunctionDef, variant?: string): string {
  const base = `${fd.name.lexeme}@L${fd.name.line}`;
  return variant === undefined ? base : `${base}#${variant}`;
}

function cloneVars(vars: readonly ExprNS.Variable[]): ExprNS.Variable[] {
  return vars.map(p => new ExprNS.Variable(p.startToken, p.endToken, p.name));
}

/** Rewrite each `return v` into `return MEMO_PUT(id, ...params, v)`. */
function rewriteReturnsCloned(
  stmts: readonly StmtNS.Stmt[],
  fd: StmtNS.FunctionDef,
  id: string,
  params: readonly ExprNS.Variable[],
): readonly StmtNS.Stmt[] {
  let changed = false;
  const out: StmtNS.Stmt[] = [];
  for (const s of stmts) {
    const replacement = rewriteStmtReturns(s, fd, id, params);
    if (replacement !== s) changed = true;
    out.push(replacement);
  }
  return changed ? out : stmts;
}

function rewriteStmtReturns(
  s: StmtNS.Stmt,
  fd: StmtNS.FunctionDef,
  id: string,
  params: readonly ExprNS.Variable[],
): StmtNS.Stmt {
  if (s instanceof StmtNS.Return) {
    if (s.value === null) return s;
    const args: ExprNS.Expr[] = [mkStr(fd, id), ...cloneVars(params), s.value];
    return shadowNode(s, { value: mkCall(fd, MEMO_PUT, args) });
  }
  if (s instanceof StmtNS.If) {
    const body = rewriteReturnsCloned(s.body, fd, id, params);
    const elseBlock = s.elseBlock
      ? rewriteReturnsCloned(s.elseBlock, fd, id, params)
      : s.elseBlock;
    if (body === s.body && elseBlock === s.elseBlock) return s;
    return shadowNode(s, {
      body: body as StmtNS.Stmt[],
      elseBlock: elseBlock as StmtNS.Stmt[] | null,
    });
  }
  if (s instanceof StmtNS.While || s instanceof StmtNS.For) {
    const body = rewriteReturnsCloned(s.body, fd, id, params);
    if (body === s.body) return s;
    return shadowNode(s, { body: body as StmtNS.Stmt[] });
  }
  return s;
}

function memoWrappedBody(
  fd: StmtNS.FunctionDef,
  body: readonly StmtNS.Stmt[],
  variant?: string,
): readonly StmtNS.Stmt[] {
  const id = memoIdFor(fd, variant);
  const params = fd.parameters.map(p => mkVar(fd, p.lexeme));

  const hasCall = mkCall(fd, MEMO_HAS, [mkStr(fd, id), ...params]);
  const getCall = mkCall(fd, MEMO_GET, [mkStr(fd, id), ...cloneVars(params)]);
  const prelude = new StmtNS.If(
    fd.startToken,
    fd.endToken,
    hasCall,
    [new StmtNS.Return(fd.startToken, fd.endToken, getCall)],
    null,
  );

  return [prelude, ...rewriteReturnsCloned(body, fd, id, params)];
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

function bodyHasMemoPrelude(body: readonly StmtNS.Stmt[]): boolean {
  const first = body[0];
  if (!(first instanceof StmtNS.If)) return false;
  const cond = first.condition;
  if (!(cond instanceof ExprNS.Call)) return false;
  const callee = cond.callee;
  return callee instanceof ExprNS.Variable && callee.name.lexeme === MEMO_HAS;
}

export const memoizationRule: TransformRule = {
  bind(wl) {
    wl.onTransformCounterBumped(memoizationRule, runtimeCallCounter, (loc, id) => {
      const f = loc.functionById(id);
      return f ? [f] : [];
    });
    // purityFunctionAnalysis is keyed by Function, so the dirtied key already IS the unit.
    wl.onTransformFactDirty(memoizationRule, purityFunctionAnalysis, (_ctx, unit) => [unit]);
    // On refute: evict the memo bucket keyed by the refuted carrier's guards.
    wl.onRefute((unit, carrier) => {
      const fd = unit.funcAst;
      if (!(fd instanceof StmtNS.FunctionDef)) return;
      clearMemoId(memoIdFor(fd, guardKeyFromGuards(directParamEntryGuardsFor(unit, carrier))));
    });
  },
  sweep(unit: Function, chain: AssumptionChain, _view: FunctionLocator): boolean {
    const fd = unit.funcAst;
    if (!(fd instanceof StmtNS.FunctionDef)) return false;
    // Fire one call before saturation so the memo wrapper is installed before
    // the runtime would otherwise refute on the next call.
    if (runtimeCallCounter.at(fd.id) < runtimeCallCounter.saturation - 1) return false;
    const pureWitness = purityFunctionAnalysis.store.readMinimal(chain, unit, v => v === true);
    if (pureWitness === undefined) return false;
    const body = forkBody(unit, pureWitness.witness);
    if (bodyHasMemoPrelude(body)) return false;
    const variant = guardKeyFromGuards(directParamEntryGuardsFor(unit, pureWitness.witness));
    const rewritten = memoWrappedBody(fd, body, variant);
    // In-place: preserve array identity so descendants inherit via bodyFor.
    body.length = 0;
    body.push(...rewritten);
    return true;
  },
};
