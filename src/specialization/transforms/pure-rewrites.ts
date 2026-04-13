// src/specialization/transforms/pure-rewrites.ts
//
// Pure (AST, facts) → AST rewrites used by the Phase 4 lowering queries
// (src/specialization/runtime/queries/lowering.ts). No FactStore, Pass,
// or worklist coupling — callers pass facts as plain functions.
//
// Structural-sharing invariant: every rewrite returns the *input* reference
// unchanged when it has no work to do, and rebuilds only the subtree where a
// change actually occurs. This is what enables the lattice's `===` equality
// to early-cutoff the downstream query chain.

import { ExprNS, StmtNS } from "../../ast-types";
import type { ConstLattice } from "../const-analysis/lattice";
import { Token } from "../../tokenizer/tokenizer";
import { TokenType } from "../../tokens";
import { MEMO_INTRINSIC_NAMES } from "../../runtime/memo";

const [MEMO_HAS, MEMO_GET, MEMO_PUT] = MEMO_INTRINSIC_NAMES;

// ─────────────────────────────────────────────────────────────────────
// Shared helpers
// ─────────────────────────────────────────────────────────────────────

// Map an array with structural sharing: if every element maps to itself,
// return the input array reference unchanged. Otherwise allocate once.
function mapShared<T>(items: readonly T[], f: (t: T) => T): T[] {
  let out: T[] | undefined;
  for (let i = 0; i < items.length; i++) {
    const before = items[i];
    const after = f(before);
    if (after !== before && out === undefined) {
      out = items.slice(0, i);
    }
    if (out !== undefined) out.push(after);
  }
  return out ?? (items as T[]);
}

function rebuildFileInput(
  original: StmtNS.FileInput,
  statements: StmtNS.Stmt[],
): StmtNS.FileInput {
  // Why not mutate the original: lowering queries must be pure w.r.t. the
  // upstream AST input. A new FileInput wrapper is constructed; unchanged
  // child statement references remain shared.
  return new StmtNS.FileInput(
    original.startToken,
    original.endToken,
    statements,
    original.varDecls,
  );
}

// ─────────────────────────────────────────────────────────────────────
// Stage 1: dead-branch elimination
// ─────────────────────────────────────────────────────────────────────

export type ConstFactFn = (nodeId: number) => ConstLattice;

function constBool(fact: ConstLattice): boolean | undefined {
  if (fact.tag !== "const") return undefined;
  if (typeof fact.value !== "boolean") return undefined;
  return fact.value;
}

// Recursive sweep over a statement list. Returns replacement list, sharing
// the input array when no child changed and no If/While was eliminated.
function sweepStmts(
  stmts: readonly StmtNS.Stmt[],
  getConst: ConstFactFn,
): StmtNS.Stmt[] {
  let out: StmtNS.Stmt[] | undefined;
  for (let i = 0; i < stmts.length; i++) {
    const s = stmts[i];
    const replacement = sweepStmt(s, getConst);

    if (replacement === s) {
      if (out !== undefined) out.push(s);
      continue;
    }

    if (out === undefined) out = stmts.slice(0, i);

    if (Array.isArray(replacement)) {
      for (const r of replacement) out.push(r);
    } else {
      out.push(replacement);
    }
  }
  return out ?? (stmts as StmtNS.Stmt[]);
}

// Returns:
//   - same ref: no change.
//   - Stmt:     replaced with a new node (wrapping same body but rewritten children).
//   - Stmt[]:   splice point (If with static cond → inline branch; While false → drop).
function sweepStmt(
  stmt: StmtNS.Stmt,
  getConst: ConstFactFn,
): StmtNS.Stmt | StmtNS.Stmt[] {
  if (stmt instanceof StmtNS.If) {
    const cond = constBool(getConst(stmt.condition.id));
    if (cond !== undefined) {
      // Splice out: inline taken branch. Recurse into the selected branch
      // first so nested static ifs collapse in one pass.
      const taken = cond ? stmt.body : (stmt.elseBlock ?? []);
      return sweepStmts(taken, getConst);
    }
    const body = sweepStmts(stmt.body, getConst);
    const elseBlock = stmt.elseBlock === null
      ? null
      : sweepStmts(stmt.elseBlock, getConst);
    if (body === stmt.body && elseBlock === stmt.elseBlock) return stmt;
    return new StmtNS.If(stmt.startToken, stmt.endToken, stmt.condition, body, elseBlock);
  }

  if (stmt instanceof StmtNS.While) {
    const cond = constBool(getConst(stmt.condition.id));
    if (cond === false) return []; // Loop never enters.
    const body = sweepStmts(stmt.body, getConst);
    if (body === stmt.body) return stmt;
    return new StmtNS.While(stmt.startToken, stmt.endToken, stmt.condition, body);
  }

  if (stmt instanceof StmtNS.For) {
    const body = sweepStmts(stmt.body, getConst);
    if (body === stmt.body) return stmt;
    return new StmtNS.For(stmt.startToken, stmt.endToken, stmt.target, stmt.iter, body);
  }

  // Function bodies are their own lowering units; leave intact.
  // Other leaves: no nested statement lists to descend into.
  return stmt;
}

export function rewriteDeadBranch(
  ast: StmtNS.FileInput,
  getConst: ConstFactFn,
): StmtNS.FileInput {
  const statements = sweepStmts(ast.statements, getConst);
  if (statements === ast.statements) return ast;
  return rebuildFileInput(ast, statements);
}

// ─────────────────────────────────────────────────────────────────────
// Stage 2: constant folding
// ─────────────────────────────────────────────────────────────────────

function isFoldable(value: unknown): value is true | false | number | string {
  return (
    typeof value === "boolean" ||
    typeof value === "number" ||
    typeof value === "string"
  );
}

// Fold an expression if the const-analysis facts report a concrete scalar.
// Returns the input reference if no fold applies; otherwise a Literal with
// the folded value (and a fresh NodeId — which is correct: the node has
// genuinely been replaced).
function foldExpr(expr: ExprNS.Expr, getConst: ConstFactFn): ExprNS.Expr {
  // Only fold compound arithmetic/comparison ops that the prior Rule folded.
  // Folding a Literal is a no-op by definition; Variables can't be folded
  // without scope info (they'd need a separate query).
  const compoundKind =
    expr instanceof ExprNS.Binary ||
    expr instanceof ExprNS.Compare ||
    expr instanceof ExprNS.BoolOp ||
    expr instanceof ExprNS.Unary;
  if (!compoundKind) return expr;

  const fact = getConst(expr.id);
  if (fact.tag !== "const") return expr;
  if (!isFoldable(fact.value)) return expr;
  return new ExprNS.Literal(expr.startToken, expr.endToken, fact.value);
}

function rewriteExpr(expr: ExprNS.Expr, getConst: ConstFactFn): ExprNS.Expr {
  // Descend first (bottom-up: inner subexpressions fold, then the parent
  // has a chance to fold with the new facts — though `getConst` is keyed
  // on the *original* node ids, so this pass only folds what the analysis
  // already proved const).
  if (expr instanceof ExprNS.Binary) {
    const left = rewriteExpr(expr.left, getConst);
    const right = rewriteExpr(expr.right, getConst);
    const self =
      left === expr.left && right === expr.right
        ? expr
        : new ExprNS.Binary(expr.startToken, expr.endToken, left, expr.operator, right);
    // Fold only on the original node id (analysis keys on that).
    const folded = foldExpr(expr, getConst);
    return folded !== expr ? folded : self;
  }
  if (expr instanceof ExprNS.Compare) {
    const left = rewriteExpr(expr.left, getConst);
    const right = rewriteExpr(expr.right, getConst);
    const self =
      left === expr.left && right === expr.right
        ? expr
        : new ExprNS.Compare(expr.startToken, expr.endToken, left, expr.operator, right);
    const folded = foldExpr(expr, getConst);
    return folded !== expr ? folded : self;
  }
  if (expr instanceof ExprNS.BoolOp) {
    const left = rewriteExpr(expr.left, getConst);
    const right = rewriteExpr(expr.right, getConst);
    const self =
      left === expr.left && right === expr.right
        ? expr
        : new ExprNS.BoolOp(expr.startToken, expr.endToken, left, expr.operator, right);
    const folded = foldExpr(expr, getConst);
    return folded !== expr ? folded : self;
  }
  if (expr instanceof ExprNS.Unary) {
    const right = rewriteExpr(expr.right, getConst);
    const self =
      right === expr.right
        ? expr
        : new ExprNS.Unary(expr.startToken, expr.endToken, expr.operator, right);
    const folded = foldExpr(expr, getConst);
    return folded !== expr ? folded : self;
  }
  if (expr instanceof ExprNS.Ternary) {
    const predicate = rewriteExpr(expr.predicate, getConst);
    const consequent = rewriteExpr(expr.consequent, getConst);
    const alternative = rewriteExpr(expr.alternative, getConst);
    if (
      predicate === expr.predicate &&
      consequent === expr.consequent &&
      alternative === expr.alternative
    ) {
      return expr;
    }
    return new ExprNS.Ternary(
      expr.startToken,
      expr.endToken,
      predicate,
      consequent,
      alternative,
    );
  }
  if (expr instanceof ExprNS.Call) {
    const callee = rewriteExpr(expr.callee, getConst);
    const args = mapShared(expr.args, (a) => rewriteExpr(a, getConst));
    if (callee === expr.callee && args === expr.args) return expr;
    return new ExprNS.Call(expr.startToken, expr.endToken, callee, args);
  }
  if (expr instanceof ExprNS.Grouping) {
    const inner = rewriteExpr(expr.expression, getConst);
    if (inner === expr.expression) return expr;
    return new ExprNS.Grouping(expr.startToken, expr.endToken, inner);
  }
  if (expr instanceof ExprNS.List) {
    const elements = mapShared(expr.elements, (e) => rewriteExpr(e, getConst));
    if (elements === expr.elements) return expr;
    return new ExprNS.List(expr.startToken, expr.endToken, elements);
  }
  if (expr instanceof ExprNS.Subscript) {
    const value = rewriteExpr(expr.value, getConst);
    const index = rewriteExpr(expr.index, getConst);
    if (value === expr.value && index === expr.index) return expr;
    return new ExprNS.Subscript(expr.startToken, expr.endToken, value, index);
  }
  if (expr instanceof ExprNS.Starred) {
    const value = rewriteExpr(expr.value, getConst);
    if (value === expr.value) return expr;
    return new ExprNS.Starred(expr.startToken, expr.endToken, value);
  }
  // Leaves: Literal, BigIntLiteral, Complex, Variable, None, Lambda*,
  // MultiLambda* — lambdas are separate scopes (matches legacy boundary).
  return expr;
}

function rewriteStmtForFold(
  stmt: StmtNS.Stmt,
  getConst: ConstFactFn,
): StmtNS.Stmt {
  if (stmt instanceof StmtNS.Assign) {
    const value = rewriteExpr(stmt.value, getConst);
    if (value === stmt.value) return stmt;
    return new StmtNS.Assign(stmt.startToken, stmt.endToken, stmt.target, value);
  }
  if (stmt instanceof StmtNS.AnnAssign) {
    const value = rewriteExpr(stmt.value, getConst);
    if (value === stmt.value) return stmt;
    return new StmtNS.AnnAssign(stmt.startToken, stmt.endToken, stmt.target, value, stmt.ann);
  }
  if (stmt instanceof StmtNS.If) {
    const condition = rewriteExpr(stmt.condition, getConst);
    const body = foldStmts(stmt.body, getConst);
    const elseBlock = stmt.elseBlock === null ? null : foldStmts(stmt.elseBlock, getConst);
    if (condition === stmt.condition && body === stmt.body && elseBlock === stmt.elseBlock) {
      return stmt;
    }
    return new StmtNS.If(stmt.startToken, stmt.endToken, condition, body, elseBlock);
  }
  if (stmt instanceof StmtNS.While) {
    const condition = rewriteExpr(stmt.condition, getConst);
    const body = foldStmts(stmt.body, getConst);
    if (condition === stmt.condition && body === stmt.body) return stmt;
    return new StmtNS.While(stmt.startToken, stmt.endToken, condition, body);
  }
  if (stmt instanceof StmtNS.For) {
    const iter = rewriteExpr(stmt.iter, getConst);
    const body = foldStmts(stmt.body, getConst);
    if (iter === stmt.iter && body === stmt.body) return stmt;
    return new StmtNS.For(stmt.startToken, stmt.endToken, stmt.target, iter, body);
  }
  if (stmt instanceof StmtNS.Return) {
    if (stmt.value === null) return stmt;
    const value = rewriteExpr(stmt.value, getConst);
    if (value === stmt.value) return stmt;
    return new StmtNS.Return(stmt.startToken, stmt.endToken, value);
  }
  if (stmt instanceof StmtNS.SimpleExpr) {
    const expression = rewriteExpr(stmt.expression, getConst);
    if (expression === stmt.expression) return stmt;
    return new StmtNS.SimpleExpr(stmt.startToken, stmt.endToken, expression);
  }
  if (stmt instanceof StmtNS.Assert) {
    const value = rewriteExpr(stmt.value, getConst);
    if (value === stmt.value) return stmt;
    return new StmtNS.Assert(stmt.startToken, stmt.endToken, value);
  }
  // FunctionDef bodies are optimized as their own units; do not descend.
  return stmt;
}

function foldStmts(
  stmts: readonly StmtNS.Stmt[],
  getConst: ConstFactFn,
): StmtNS.Stmt[] {
  return mapShared(stmts as StmtNS.Stmt[], (s) => rewriteStmtForFold(s, getConst));
}

export function rewriteConstantFold(
  ast: StmtNS.FileInput,
  getConst: ConstFactFn,
): StmtNS.FileInput {
  const statements = foldStmts(ast.statements, getConst);
  if (statements === ast.statements) return ast;
  return rebuildFileInput(ast, statements);
}

// ─────────────────────────────────────────────────────────────────────
// Stage 3: memoize wrap (pure)
// ─────────────────────────────────────────────────────────────────────

export type ShouldMemoizeFn = (scopeId: number) => boolean;

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

function mkCall(
  fd: StmtNS.FunctionDef,
  fn: string,
  args: ExprNS.Expr[],
): ExprNS.Call {
  return new ExprNS.Call(fd.startToken, fd.endToken, mkVar(fd, fn), args);
}

function mintMemoId(fd: StmtNS.FunctionDef): string {
  return `${fd.name.lexeme}@L${fd.name.line}`;
}

// Rewrite `return E` → `return __memo_put(id, params..., E)` in a stmt list,
// descending into If/While/For bodies (matching legacy rewriteReturns).
function rewriteReturns(
  stmts: readonly StmtNS.Stmt[],
  fd: StmtNS.FunctionDef,
  id: string,
  paramNames: readonly string[],
): StmtNS.Stmt[] {
  return mapShared(stmts as StmtNS.Stmt[], (s) => {
    if (s instanceof StmtNS.Return) {
      if (s.value === null) return s;
      const args: ExprNS.Expr[] = [
        mkStr(fd, id),
        ...paramNames.map((n) => mkVar(fd, n)),
        s.value,
      ];
      const wrapped = mkCall(fd, MEMO_PUT, args);
      return new StmtNS.Return(s.startToken, s.endToken, wrapped);
    }
    if (s instanceof StmtNS.If) {
      const body = rewriteReturns(s.body, fd, id, paramNames);
      const elseBlock =
        s.elseBlock === null ? null : rewriteReturns(s.elseBlock, fd, id, paramNames);
      if (body === s.body && elseBlock === s.elseBlock) return s;
      return new StmtNS.If(s.startToken, s.endToken, s.condition, body, elseBlock);
    }
    if (s instanceof StmtNS.While) {
      const body = rewriteReturns(s.body, fd, id, paramNames);
      if (body === s.body) return s;
      return new StmtNS.While(s.startToken, s.endToken, s.condition, body);
    }
    if (s instanceof StmtNS.For) {
      const body = rewriteReturns(s.body, fd, id, paramNames);
      if (body === s.body) return s;
      return new StmtNS.For(s.startToken, s.endToken, s.target, s.iter, body);
    }
    return s;
  });
}

export function wrapMemoize(fd: StmtNS.FunctionDef): StmtNS.FunctionDef {
  // Pure wrap: produces a new FunctionDef with a new body. Unlike the legacy
  // in-place `applyMemoizationWrap`, no `isAlreadyWrapped` guard is needed —
  // idempotence is provided by the lowering query's cache + `===` equality.
  const id = mintMemoId(fd);
  const paramNames = fd.parameters.map((p) => p.lexeme);

  const hasArgs: ExprNS.Expr[] = [mkStr(fd, id), ...paramNames.map((n) => mkVar(fd, n))];
  const getArgs: ExprNS.Expr[] = [mkStr(fd, id), ...paramNames.map((n) => mkVar(fd, n))];
  const hasCall = mkCall(fd, MEMO_HAS, hasArgs);
  const getCall = mkCall(fd, MEMO_GET, getArgs);
  const prelude = new StmtNS.If(
    fd.startToken,
    fd.endToken,
    hasCall,
    [new StmtNS.Return(fd.startToken, fd.endToken, getCall)],
    null,
  );

  const rewrittenBody = rewriteReturns(fd.body, fd, id, paramNames);
  const newBody: StmtNS.Stmt[] = [prelude, ...rewrittenBody];

  return new StmtNS.FunctionDef(
    fd.startToken,
    fd.endToken,
    fd.name,
    fd.parameters,
    newBody,
    fd.varDecls,
  );
}

// Walk top-level statements and wrap any FunctionDef the caller approves.
// Nested FunctionDefs are not wrapped here — each scope is a separate unit.
export function rewriteMemoize(
  ast: StmtNS.FileInput,
  shouldMemoize: ShouldMemoizeFn,
): StmtNS.FileInput {
  const statements = mapShared(ast.statements, (s) => {
    if (s instanceof StmtNS.FunctionDef && shouldMemoize(s.id)) {
      return wrapMemoize(s);
    }
    return s;
  });
  if (statements === ast.statements) return ast;
  return rebuildFileInput(ast, statements);
}
