// src/specialization/memoization-analysis/purity.ts — syntactic purity check
//
// Conservative one-shot purity check over a FunctionDef body. Deliberately
// not a full AnalysisModule: purity here is a compile-time syntactic property
// used as a gate on memoization. It does not integrate with the DFA driver.
//
// Pure means all of the following hold for every statement reachable from
// the body (recursing into nested If/While/For):
//   - No Assign / AnnAssign whose target is not a purely local name.
//     (Any write to a Subscript target is treated as impure — we cannot
//     prove the subscripted object is function-local.)
//   - No Global / NonLocal declaration.
//   - No Call to an identifier outside the allow-list (the function itself,
//     for self-recursion). Calls are conservatively considered impure
//     because we have no cross-function summary.
//   - No SimpleExpr at statement position whose only use is side effects
//     (e.g. `print(x)` as a bare statement).
//   - No nested FunctionDef (closures can hide side effects).
//
// Caveat: reference-typed arguments (lists, dicts, user objects) are not
// analysed here. `def g(x): return x` is classified pure, but if a caller
// mutates the list it passed in, the memoization cache will serve stale
// entries. v1 documents this as a known limitation; a proper fix requires
// cross-function escape analysis.

import { ExprNS, StmtNS } from "../../ast-types";

export function isPureFunctionDef(fd: StmtNS.FunctionDef): boolean {
  const selfName = fd.name.lexeme;
  const localNames = new Set<string>(fd.parameters.map(p => p.lexeme));
  for (const tok of fd.varDecls) localNames.add(tok.lexeme);

  return stmtsArePure(fd.body, selfName, localNames);
}

function stmtsArePure(stmts: StmtNS.Stmt[], self: string, locals: Set<string>): boolean {
  for (const s of stmts) {
    if (!stmtIsPure(s, self, locals)) return false;
  }
  return true;
}

function stmtIsPure(stmt: StmtNS.Stmt, self: string, locals: Set<string>): boolean {
  if (stmt instanceof StmtNS.Pass) return true;
  if (stmt instanceof StmtNS.Break) return true;
  if (stmt instanceof StmtNS.Continue) return true;
  if (stmt instanceof StmtNS.Return) {
    return stmt.value === null || exprIsPure(stmt.value, self, locals);
  }
  if (stmt instanceof StmtNS.Assign || stmt instanceof StmtNS.AnnAssign) {
    // Target must be a bare local Variable; subscript assignment is impure.
    if (!(stmt.target instanceof ExprNS.Variable)) return false;
    if (!locals.has(stmt.target.name.lexeme)) return false;
    return exprIsPure(stmt.value, self, locals);
  }
  if (stmt instanceof StmtNS.If) {
    if (!exprIsPure(stmt.condition, self, locals)) return false;
    if (!stmtsArePure(stmt.body, self, locals)) return false;
    if (stmt.elseBlock && !stmtsArePure(stmt.elseBlock, self, locals)) return false;
    return true;
  }
  if (stmt instanceof StmtNS.While) {
    return exprIsPure(stmt.condition, self, locals) && stmtsArePure(stmt.body, self, locals);
  }
  if (stmt instanceof StmtNS.For) {
    return exprIsPure(stmt.iter, self, locals) && stmtsArePure(stmt.body, self, locals);
  }
  // Everything else — FunctionDef (nested), Global, NonLocal, FromImport,
  // SimpleExpr, Assert, FileInput — treated as impure / unsupported.
  return false;
}

function exprIsPure(expr: ExprNS.Expr, self: string, locals: Set<string>): boolean {
  if (expr instanceof ExprNS.Literal) return true;
  if (expr instanceof ExprNS.BigIntLiteral) return true;
  if (expr instanceof ExprNS.Complex) return true;
  if (expr instanceof ExprNS.None) return true;
  // Only parameter / locally-declared name reads are pure. A bare reference
  // to a free (likely global) name is impure: the global may be reassigned
  // between calls, which would turn a cache hit into a stale read.
  if (expr instanceof ExprNS.Variable) return locals.has(expr.name.lexeme);
  if (expr instanceof ExprNS.Grouping) return exprIsPure(expr.expression, self, locals);
  if (
    expr instanceof ExprNS.Binary ||
    expr instanceof ExprNS.Compare ||
    expr instanceof ExprNS.BoolOp
  ) {
    return exprIsPure(expr.left, self, locals) && exprIsPure(expr.right, self, locals);
  }
  if (expr instanceof ExprNS.Unary) return exprIsPure(expr.right, self, locals);
  if (expr instanceof ExprNS.Ternary) {
    return (
      exprIsPure(expr.predicate, self, locals) &&
      exprIsPure(expr.consequent, self, locals) &&
      exprIsPure(expr.alternative, self, locals)
    );
  }
  if (expr instanceof ExprNS.Call) {
    // Only self-recursion is considered pure. Any other callee (including
    // builtins like print, abs, etc.) is impure from this analysis's POV —
    // a proper cross-function purity summary is out of scope for v1.
    if (!(expr.callee instanceof ExprNS.Variable)) return false;
    if (expr.callee.name.lexeme !== self) return false;
    for (const a of expr.args) {
      if (!exprIsPure(a, self, locals)) return false;
    }
    return true;
  }
  // List / Subscript / Starred / Lambda / MultiLambda — conservatively impure.
  return false;
}
