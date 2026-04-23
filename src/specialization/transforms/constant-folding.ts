// Constant folding. Idempotent: rewriting Binary to Literal removes the
// "const" fact match.
//
// Witness-aware: every actual fold recovers the shallowest chain that proves
// the expression constant, then publishes that fold at the witness chain.
// Later witness groups clone from earlier ones, so one sweep can materialize a
// whole ancestor chain of folds shallow→deep.

import { ExprNS, StmtNS } from "../../ast-types";
import type { ConstLattice } from "../const-analysis/lattice";
import type { TransformRule } from "../framework/analysis";
import { unitOfBlock, wakeOwningUnit } from "../framework/analysis";
import type { Speculation } from "../framework/assumption-chain";
import { visibleBody } from "../framework/assumption-bodies";
import { constAnalysis } from "../framework/dfa-analyses";
import type { Unit } from "../framework/function-unit";
import type { ProgramTopology } from "../framework/topology";
import { BaseStmtVisitor, runWitnessSweep, walkExprs } from "./witness-utils";

function constInfo(
  chain: Speculation,
  topology: ProgramTopology,
  nodeId: number,
): { value: Extract<ConstLattice, { tag: "const" }>; witness: Speculation } | undefined {
  return constAnalysis
    .perExpr(topology)
    .readMinimal(chain, nodeId, (cv: ConstLattice) => cv.tag === "const") as
    | { value: Extract<ConstLattice, { tag: "const" }>; witness: Speculation }
    | undefined;
}

function collectWitnesses(
  chain: Speculation,
  topology: ProgramTopology,
  stmts: readonly StmtNS.Stmt[],
  out: Set<Speculation>,
): void {
  walkExprs(stmts, (e) => {
    if (!(e instanceof ExprNS.Binary)) return;
    const info = constInfo(chain, topology, e.id);
    if (info !== undefined) out.add(info.witness);
  });
}

class ConstFoldExprVisitor implements ExprNS.Visitor<ExprNS.Expr> {
  changed = false;

  constructor(
    private readonly chain: Speculation,
    private readonly topology: ProgramTopology,
  ) {}

  private tryRewrite(expr: ExprNS.Expr): ExprNS.Expr {
    if (!(expr instanceof ExprNS.Binary)) return expr;
    const cv = constInfo(this.chain, this.topology, expr.id);
    if (cv === undefined || cv.witness !== this.chain) return expr;
    this.changed = true;
    return new ExprNS.Literal(expr.startToken, expr.endToken, cv.value.value);
  }

  rewrite(expr: ExprNS.Expr): ExprNS.Expr {
    return expr.accept(this);
  }

  visitBinaryExpr(expr: ExprNS.Binary): ExprNS.Expr {
    expr.left = expr.left.accept(this);
    expr.right = expr.right.accept(this);
    return this.tryRewrite(expr);
  }
  visitCompareExpr(expr: ExprNS.Compare): ExprNS.Expr {
    expr.left = expr.left.accept(this);
    expr.right = expr.right.accept(this);
    return expr;
  }
  visitBoolOpExpr(expr: ExprNS.BoolOp): ExprNS.Expr {
    expr.left = expr.left.accept(this);
    expr.right = expr.right.accept(this);
    return expr;
  }
  visitUnaryExpr(expr: ExprNS.Unary): ExprNS.Expr {
    expr.right = expr.right.accept(this);
    return expr;
  }
  visitTernaryExpr(expr: ExprNS.Ternary): ExprNS.Expr {
    expr.predicate = expr.predicate.accept(this);
    expr.consequent = expr.consequent.accept(this);
    expr.alternative = expr.alternative.accept(this);
    return expr;
  }
  visitCallExpr(expr: ExprNS.Call): ExprNS.Expr {
    expr.callee = expr.callee.accept(this);
    for (let i = 0; i < expr.args.length; i++) {
      expr.args[i] = expr.args[i].accept(this);
    }
    return expr;
  }
  visitListExpr(expr: ExprNS.List): ExprNS.Expr {
    for (let i = 0; i < expr.elements.length; i++) {
      expr.elements[i] = expr.elements[i].accept(this);
    }
    return expr;
  }
  visitSubscriptExpr(expr: ExprNS.Subscript): ExprNS.Expr {
    expr.value = expr.value.accept(this);
    expr.index = expr.index.accept(this);
    return expr;
  }
  visitGroupingExpr(expr: ExprNS.Grouping): ExprNS.Expr {
    expr.expression = expr.expression.accept(this);
    return expr;
  }
  visitStarredExpr(expr: ExprNS.Starred): ExprNS.Expr {
    expr.value = expr.value.accept(this);
    return expr;
  }
  // Lambda bodies: separate scope, do not descend.
  visitLambdaExpr(expr: ExprNS.Lambda): ExprNS.Expr {
    return expr;
  }
  visitMultiLambdaExpr(expr: ExprNS.MultiLambda): ExprNS.Expr {
    return expr;
  }
  visitLiteralExpr(expr: ExprNS.Literal): ExprNS.Expr {
    return expr;
  }
  visitBigIntLiteralExpr(expr: ExprNS.BigIntLiteral): ExprNS.Expr {
    return expr;
  }
  visitComplexExpr(expr: ExprNS.Complex): ExprNS.Expr {
    return expr;
  }
  visitVariableExpr(expr: ExprNS.Variable): ExprNS.Expr {
    return expr;
  }
  visitNoneExpr(expr: ExprNS.None): ExprNS.Expr {
    return expr;
  }
}

class ConstFoldStmtVisitor extends BaseStmtVisitor {
  private readonly exprVisitor: ConstFoldExprVisitor;

  constructor(chain: Speculation, topology: ProgramTopology) {
    super();
    this.exprVisitor = new ConstFoldExprVisitor(chain, topology);
  }

  get changed(): boolean {
    return this.exprVisitor.changed;
  }

  private rewriteExpr(expr: ExprNS.Expr): ExprNS.Expr {
    return this.exprVisitor.rewrite(expr);
  }

  sweep(stmts: StmtNS.Stmt[]): void {
    for (const stmt of stmts) stmt.accept(this);
  }

  visitAssignStmt(stmt: StmtNS.Assign): void {
    stmt.value = this.rewriteExpr(stmt.value);
  }
  visitAnnAssignStmt(stmt: StmtNS.AnnAssign): void {
    stmt.value = this.rewriteExpr(stmt.value);
  }
  visitIfStmt(stmt: StmtNS.If): void {
    stmt.condition = this.rewriteExpr(stmt.condition);
    this.sweep(stmt.body);
    if (stmt.elseBlock) this.sweep(stmt.elseBlock);
  }
  visitWhileStmt(stmt: StmtNS.While): void {
    stmt.condition = this.rewriteExpr(stmt.condition);
    this.sweep(stmt.body);
  }
  visitForStmt(stmt: StmtNS.For): void {
    stmt.iter = this.rewriteExpr(stmt.iter);
    this.sweep(stmt.body);
  }
  visitReturnStmt(stmt: StmtNS.Return): void {
    if (stmt.value) stmt.value = this.rewriteExpr(stmt.value);
  }
  visitSimpleExprStmt(stmt: StmtNS.SimpleExpr): void {
    stmt.expression = this.rewriteExpr(stmt.expression);
  }
  visitAssertStmt(stmt: StmtNS.Assert): void {
    stmt.value = this.rewriteExpr(stmt.value);
  }
  visitFileInputStmt(stmt: StmtNS.FileInput): void {
    this.sweep(stmt.statements);
  }
}

export const constantFoldingRule: TransformRule = {
  sweep(unit: Unit, chain: Speculation, topology: ProgramTopology): boolean {
    const witnesses = new Set<Speculation>();
    collectWitnesses(chain, topology, visibleBody(unit, chain), witnesses);
    return runWitnessSweep(
      unit,
      witnesses,
      (witness) => new ConstFoldStmtVisitor(witness, topology),
    );
  },
  bind(wl) {
    wl.onTransformFactDirty(
      constantFoldingRule,
      constAnalysis.facts,
      wakeOwningUnit(unitOfBlock),
    );
  },
};
