import { ExprNS, StmtNS } from "../../ast-types";
import type { Speculation } from "../framework/assumption-chain";
import { forkBody } from "../framework/assumption-bodies";
import type { Unit } from "../framework/function-unit";

/** Walk every expression inside `stmts` and invoke `onExpr` on each one. Used
 *  by transform-time witness collection: the caller's `onExpr` probes the
 *  relevant analysis at the expression's node id and adds any discovered
 *  witness chain to `out`. The traversal itself is identical across all such
 *  transforms, so only the per-expression probe varies. */
export function walkExprs(
  stmts: readonly StmtNS.Stmt[],
  onExpr: (expr: ExprNS.Expr) => void,
): void {
  for (const s of stmts) walkStmt(s, onExpr);
}

function walkStmt(s: StmtNS.Stmt, onExpr: (expr: ExprNS.Expr) => void): void {
  if (s instanceof StmtNS.Assign || s instanceof StmtNS.AnnAssign) {
    walkExpr(s.value, onExpr);
    return;
  }
  if (s instanceof StmtNS.Return) {
    if (s.value) walkExpr(s.value, onExpr);
    return;
  }
  if (s instanceof StmtNS.If) {
    walkExpr(s.condition, onExpr);
    walkExprs(s.body, onExpr);
    if (s.elseBlock) walkExprs(s.elseBlock, onExpr);
    return;
  }
  if (s instanceof StmtNS.While) {
    walkExpr(s.condition, onExpr);
    walkExprs(s.body, onExpr);
    return;
  }
  if (s instanceof StmtNS.For) {
    walkExpr(s.iter, onExpr);
    walkExprs(s.body, onExpr);
    return;
  }
  if (s instanceof StmtNS.SimpleExpr) {
    walkExpr(s.expression, onExpr);
    return;
  }
  if (s instanceof StmtNS.Assert) {
    walkExpr(s.value, onExpr);
    return;
  }
  if (s instanceof StmtNS.FileInput) walkExprs(s.statements, onExpr);
}

function walkExpr(e: ExprNS.Expr, onExpr: (expr: ExprNS.Expr) => void): void {
  onExpr(e);
  if (e instanceof ExprNS.Binary || e instanceof ExprNS.Compare || e instanceof ExprNS.BoolOp) {
    walkExpr(e.left, onExpr);
    walkExpr(e.right, onExpr);
    return;
  }
  if (e instanceof ExprNS.Unary) {
    walkExpr(e.right, onExpr);
    return;
  }
  if (e instanceof ExprNS.Ternary) {
    walkExpr(e.predicate, onExpr);
    walkExpr(e.consequent, onExpr);
    walkExpr(e.alternative, onExpr);
    return;
  }
  if (e instanceof ExprNS.Call) {
    walkExpr(e.callee, onExpr);
    for (const a of e.args) walkExpr(a, onExpr);
    return;
  }
  if (e instanceof ExprNS.List) {
    for (const el of e.elements) walkExpr(el, onExpr);
    return;
  }
  if (e instanceof ExprNS.Subscript) {
    walkExpr(e.value, onExpr);
    walkExpr(e.index, onExpr);
    return;
  }
  if (e instanceof ExprNS.Grouping) {
    walkExpr(e.expression, onExpr);
    return;
  }
  if (e instanceof ExprNS.Starred) walkExpr(e.value, onExpr);
}

export function lineageTo(chain: Speculation): Speculation[] {
  const out: Speculation[] = [];
  for (let cur: Speculation | undefined = chain; cur !== undefined; cur = cur.parent) {
    out.push(cur);
  }
  out.reverse();
  return out;
}

function sortByDepth<T extends Speculation>(chains: Iterable<T>): T[] {
  return Array.from(chains).sort((a, b) => a.depth - b.depth);
}

export function deepestWitness(
  ...witnesses: ReadonlyArray<Speculation | undefined>
): Speculation | undefined {
  let deepest: Speculation | undefined;
  for (const witness of witnesses) {
    if (witness === undefined) continue;
    if (deepest === undefined || deepest.depth < witness.depth) deepest = witness;
  }
  return deepest;
}

/** Base class for the statement visitors used by witness-aware transforms.
 *  Supplies no-op defaults for every statement kind that neither descends
 *  into bodies nor interacts with embedded expressions under the current
 *  transform family. Subclasses override what they need — typically the
 *  body-descending kinds (`If`/`While`/`For`/`FileInput`) and whichever
 *  expression-bearing statement kinds the transform rewrites. */
export abstract class BaseStmtVisitor implements StmtNS.Visitor<void> {
  abstract visitIfStmt(stmt: StmtNS.If): void;
  abstract visitWhileStmt(stmt: StmtNS.While): void;
  abstract visitForStmt(stmt: StmtNS.For): void;
  abstract visitFileInputStmt(stmt: StmtNS.FileInput): void;
  // Nested functions: own unit handles them.
  visitFunctionDefStmt(_stmt: StmtNS.FunctionDef): void {}
  visitAssignStmt(_stmt: StmtNS.Assign): void {}
  visitAnnAssignStmt(_stmt: StmtNS.AnnAssign): void {}
  visitReturnStmt(_stmt: StmtNS.Return): void {}
  visitSimpleExprStmt(_stmt: StmtNS.SimpleExpr): void {}
  visitAssertStmt(_stmt: StmtNS.Assert): void {}
  visitPassStmt(_stmt: StmtNS.Pass): void {}
  visitBreakStmt(_stmt: StmtNS.Break): void {}
  visitContinueStmt(_stmt: StmtNS.Continue): void {}
  visitGlobalStmt(_stmt: StmtNS.Global): void {}
  visitNonLocalStmt(_stmt: StmtNS.NonLocal): void {}
  visitFromImportStmt(_stmt: StmtNS.FromImport): void {}
}

interface SweepingVisitor {
  readonly changed: boolean;
  sweep(body: StmtNS.Stmt[]): void;
}

/** Shared outer loop for witness-aware transforms. Sorts `witnesses` by
 *  depth (shallow→deep), forks the body at each witness, and runs a fresh
 *  visitor over it. Returns whether any sweep reported a rewrite. */
export function runWitnessSweep(
  unit: Unit,
  witnesses: Iterable<Speculation>,
  makeVisitor: (witness: Speculation) => SweepingVisitor,
): boolean {
  const ordered = sortByDepth(witnesses);
  if (ordered.length === 0) return false;
  let changed = false;
  for (const witness of ordered) {
    const body = forkBody(unit, witness);
    const v = makeVisitor(witness);
    v.sweep(body);
    changed = v.changed || changed;
  }
  return changed;
}

export function shallowestWitness(
  ...witnesses: ReadonlyArray<Speculation | undefined>
): Speculation | undefined {
  let shallowest: Speculation | undefined;
  for (const witness of witnesses) {
    if (witness === undefined) continue;
    if (shallowest === undefined || shallowest.depth > witness.depth) shallowest = witness;
  }
  return shallowest;
}
