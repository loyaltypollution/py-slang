import { ExprNS, StmtNS } from "../../ast-types";
import { MEMO_INTRINSIC_NAMES } from "../../runtime/memo";
import { Token } from "../../tokenizer/tokenizer";
import { TokenType } from "../../tokenizer";
import { directParamEntryGuardsFor, guardKeyFromGuards } from "../entry-guards";
import type { TransformRule } from "../framework/analysis";
import { unitOfFunctionId, wakeOwningUnit } from "../framework/analysis";
import { shadowNode } from "../framework/ast-deep-clone";
import { type Speculation } from "../framework/assumption-chain";
import { forkBody } from "../framework/assumption-bodies";
import type { Unit } from "../framework/function-unit";
import { RUNTIME_CALL_COUNT_SAT, runtimeCallCounter } from "../framework/runtime-analyses";
import type { ProgramTopology } from "../framework/topology";
import { purityScopeAnalysis } from "../purity-analysis/analysis";

export const MEMOIZATION_THRESHOLD = RUNTIME_CALL_COUNT_SAT - 1;

const [MEMO_HAS, MEMO_GET, MEMO_PUT] = MEMO_INTRINSIC_NAMES;

export function memoIdFor(fd: StmtNS.FunctionDef, variant?: string): string {
  const base = `${fd.name.lexeme}@L${fd.name.line}`;
  return variant === undefined ? base : `${base}#${variant}`;
}

/** Clone each Variable so every call-site gets a distinct AST node.
 *  Sharing a single Variable across multiple call arguments would violate
 *  the invariant that each AST node has one parent / one position. */
function cloneVars(vars: readonly ExprNS.Variable[]): ExprNS.Variable[] {
  return vars.map(p => new ExprNS.Variable(p.startToken, p.endToken, p.name));
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
        const args: ExprNS.Expr[] = [mkStr(fd, id), ...cloneVars(params), s.value];
        out.push(shadowNode(s, { value: mkCall(fd, MEMO_PUT, args) }));
      } else {
        out.push(s);
      }
    } else if (s instanceof StmtNS.If) {
      const body = rewriteReturnsCloned(s.body, fd, id, params);
      const elseBlock = s.elseBlock ? rewriteReturnsCloned(s.elseBlock, fd, id, params) : s.elseBlock;
      if (body !== s.body || elseBlock !== s.elseBlock) {
        changed = true;
        out.push(shadowNode(s, {
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
        out.push(shadowNode(s, { body: body as StmtNS.Stmt[] }));
      } else {
        out.push(s);
      }
    } else {
      out.push(s);
    }
  }
  return changed ? out : stmts;
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

function memoizationWitnessFor(
  fd: StmtNS.FunctionDef,
  chain: Speculation,
): { value: true; witness: Speculation } | undefined {
  return purityScopeAnalysis.readMinimal(chain, fd.id, value => value === true) as
    | { value: true; witness: Speculation }
    | undefined;
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
  bind(wl) {
    const wakeUnit = wakeOwningUnit(unitOfFunctionId);
    wl.onTransformCounterBumped(memoizationRule, runtimeCallCounter, wakeUnit);
    wl.onTransformFactDirty(memoizationRule, purityScopeAnalysis, wakeUnit);
  },
  sweep(unit: Unit, chain: Speculation, _topology: ProgramTopology): boolean {
    const fd = unit.funcAst;
    if (!(fd instanceof StmtNS.FunctionDef)) return false;
    // Profitability gate: call hotness is a profile counter, not a lattice
    // cell. `runtimeCallCounter.at` is the only read path — there is no
    // chain-keyed API, so "read at ROOT" is structural rather than doc-only.
    const count = runtimeCallCounter.at(fd.id);
    if (count < MEMOIZATION_THRESHOLD) return false;
    // Semantic witness: the shallowest chain that proves purity. This IS
    // the rewrite's authorization, and therefore also its publication sink.
    const witnessInfo = memoizationWitnessFor(fd, chain);
    if (witnessInfo === undefined) return false;
    const { witness: witnessChain } = witnessInfo;
    // Publish the memoized body at the witness, not at the sweep chain.
    // If purity holds at ROOT, the rewrite lands on the shared AST once;
    // descendant sweeps see it via `bodyFor` walk and short-circuit on the
    // prelude check below instead of redundantly re-memoizing.
    const body = forkBody(unit, witnessChain);
    if (bodyHasMemoPrelude(body)) return false;
    // Memo variant identity derives from the witness context, so sibling
    // contexts that readMinimal the same witness converge on the same
    // memo table.
    const variant = guardKeyFromGuards(directParamEntryGuardsFor(unit, witnessChain));
    const rewritten = memoWrappedBody(fd, body, variant);
    // In-place replacement of the body's contents. The array identity is
    // preserved so descendant chain nodes that inherit via bodyFor walk
    // still see the rewrite.
    body.length = 0;
    body.push(...rewritten);
    return true;
  },
};
