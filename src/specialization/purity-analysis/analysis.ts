// src/specialization/purity-analysis/analysis.ts
//
// Two-level purity analysis.
//
// `PurityEffectAnalysis` (AnalysisPass<PureEffect>) runs a forward
// may-analysis over each scope's CFG and annotates every Expr node with
// a `pureEffect` hint. The slot env tracks per-local purity so reads of
// a previously-assigned local pick up the rhs's effect.
//
// `PurityScopePass` (ScopePass) folds the per-expression marks into a
// scope-level `pure` hint on the enclosing FunctionDef, layering on
// structural rules the lattice alone can't express:
//   - Assign/AnnAssign target must be a frame-local Variable
//   - For target must be frame-local
//   - Nested FunctionDef / Global / NonLocal / FromImport / SimpleExpr
//     / Assert are unsupported in a pure body
//   - A Call to the enclosing function with pure args is exempt from
//     the expression-level "Call is impure" verdict (self-recursion)
//
// `MemoizationTransformRule.matches` reads `hint.pure === true` as its
// purity gate. FileInput units are skipped (the top-level scope is
// never a memoization callee).

import { ExprNS, StmtNS } from "../../ast-types";
import type { Token } from "../../tokenizer";
import type { FunctionUnit } from "../framework/function-unit";
import type { HintStore, OptimizationHint } from "../framework/hint";
import type { AnalysisPass, ScopePass } from "../framework/interfaces";
import type { SlotLookup } from "../framework/slot-table";
import {
  IMPURE,
  PURE,
  PURE_EFFECT_FIELD,
  PURE_FIELD,
  joinEffect,
  leqEffect,
  meetEffect,
  type PureEffect,
} from "./lattice";

// ── Expression-level: AnalysisPass<PureEffect> ──────────────────────────

class PurityEffectVisitor implements ExprNS.Visitor<PureEffect> {
  constructor(
    private readonly hints: HintStore,
    private readonly env: { get(slot: number): PureEffect | undefined },
    private readonly slotLookup: SlotLookup,
  ) {}

  private annotate(node: ExprNS.Expr, val: PureEffect): PureEffect {
    const existing = this.hints.get(node) ?? {};
    this.hints.set(node, { ...existing, [PURE_EFFECT_FIELD]: val });
    return val;
  }

  visitLiteralExpr(e: ExprNS.Literal): PureEffect {
    return this.annotate(e, PURE);
  }
  visitBigIntLiteralExpr(e: ExprNS.BigIntLiteral): PureEffect {
    return this.annotate(e, PURE);
  }
  visitComplexExpr(e: ExprNS.Complex): PureEffect {
    return this.annotate(e, PURE);
  }
  visitNoneExpr(e: ExprNS.None): PureEffect {
    return this.annotate(e, PURE);
  }

  visitVariableExpr(e: ExprNS.Variable): PureEffect {
    const info = this.slotLookup(e.name);
    if (info.isPrimitive) return this.annotate(e, IMPURE);
    if (info.envLevel !== 0) return this.annotate(e, IMPURE);
    // Missing slot = bottom (PURE): parameter at entry or predecessor
    // OUT not yet propagated. Fixpoint widens to IMPURE if warranted.
    return this.annotate(e, this.env.get(info.slot) ?? PURE);
  }

  visitGroupingExpr(e: ExprNS.Grouping): PureEffect {
    return this.annotate(e, e.expression.accept(this));
  }
  visitBinaryExpr(e: ExprNS.Binary): PureEffect {
    return this.annotate(e, joinEffect(e.left.accept(this), e.right.accept(this)));
  }
  visitCompareExpr(e: ExprNS.Compare): PureEffect {
    return this.annotate(e, joinEffect(e.left.accept(this), e.right.accept(this)));
  }
  visitBoolOpExpr(e: ExprNS.BoolOp): PureEffect {
    return this.annotate(e, joinEffect(e.left.accept(this), e.right.accept(this)));
  }
  visitUnaryExpr(e: ExprNS.Unary): PureEffect {
    return this.annotate(e, e.right.accept(this));
  }
  visitTernaryExpr(e: ExprNS.Ternary): PureEffect {
    return this.annotate(
      e,
      joinEffect(
        joinEffect(e.predicate.accept(this), e.consequent.accept(this)),
        e.alternative.accept(this),
      ),
    );
  }

  // Calls are impure at the expression level; PurityScopePass re-checks
  // self-recursion as a structural exemption.
  visitCallExpr(e: ExprNS.Call): PureEffect {
    e.callee.accept(this);
    for (const a of e.args) a.accept(this);
    return this.annotate(e, IMPURE);
  }

  visitLambdaExpr(e: ExprNS.Lambda): PureEffect {
    return this.annotate(e, IMPURE);
  }
  visitMultiLambdaExpr(e: ExprNS.MultiLambda): PureEffect {
    return this.annotate(e, IMPURE);
  }
  visitListExpr(e: ExprNS.List): PureEffect {
    for (const el of e.elements) el.accept(this);
    return this.annotate(e, IMPURE);
  }
  visitSubscriptExpr(e: ExprNS.Subscript): PureEffect {
    e.value.accept(this);
    e.index.accept(this);
    return this.annotate(e, IMPURE);
  }
  visitStarredExpr(e: ExprNS.Starred): PureEffect {
    e.value.accept(this);
    return this.annotate(e, IMPURE);
  }
}

export class PurityEffectAnalysis implements AnalysisPass<PureEffect> {
  readonly name = PURE_EFFECT_FIELD;
  readonly mergeKind = "may" as const;
  readonly direction = "forward" as const;

  latticeEquals(a: unknown, b: unknown): boolean {
    return a === b;
  }
  top(): PureEffect {
    return IMPURE;
  }
  bottom(): PureEffect {
    return PURE;
  }
  join = joinEffect;
  meet = meetEffect;
  leq = leqEffect;

  makeExprVisitor(
    hints: HintStore,
    env: { get(slot: number): PureEffect | undefined },
    slotLookup: SlotLookup,
  ): ExprNS.Visitor<PureEffect> {
    return new PurityEffectVisitor(hints, env, slotLookup);
  }

  // No `observeValue` / `mergeIntoHint`: purity is a static property of
  // the AST, not something observable from runtime values.
}

// ── Scope-level: ScopePass folding per-expr marks to hint.pure ─────────

export class PurityScopePass implements ScopePass {
  readonly name = "purity";

  run(unit: FunctionUnit): void {
    const fd = unit.funcAst;
    if (!(fd instanceof StmtNS.FunctionDef)) return;
    const self = fd.name.lexeme;

    const isLocal = (tok: Token): boolean => {
      const info = unit.slotLookup(tok);
      return !info.isPrimitive && info.envLevel === 0;
    };

    // Scope-level exemption: a Call to `self` with all-pure arguments is
    // pure (self-recursion). Any other expr defers to its expr-level mark.
    const exprPure = (expr: ExprNS.Expr): boolean => {
      if (
        expr instanceof ExprNS.Call &&
        expr.callee instanceof ExprNS.Variable &&
        expr.callee.name.lexeme === self
      ) {
        return expr.args.every(exprPure);
      }
      return unit.hints.get(expr)?.[PURE_EFFECT_FIELD] === PURE;
    };

    const stmtPure = (stmt: StmtNS.Stmt): boolean => {
      if (stmt instanceof StmtNS.Pass) return true;
      if (stmt instanceof StmtNS.Break) return true;
      if (stmt instanceof StmtNS.Continue) return true;
      if (stmt instanceof StmtNS.Return) {
        return stmt.value === null || exprPure(stmt.value);
      }
      if (stmt instanceof StmtNS.Assign || stmt instanceof StmtNS.AnnAssign) {
        return (
          stmt.target instanceof ExprNS.Variable &&
          isLocal(stmt.target.name) &&
          exprPure(stmt.value)
        );
      }
      if (stmt instanceof StmtNS.If) {
        return (
          exprPure(stmt.condition) &&
          stmt.body.every(stmtPure) &&
          (!stmt.elseBlock || stmt.elseBlock.every(stmtPure))
        );
      }
      if (stmt instanceof StmtNS.While) {
        return exprPure(stmt.condition) && stmt.body.every(stmtPure);
      }
      if (stmt instanceof StmtNS.For) {
        return isLocal(stmt.target) && exprPure(stmt.iter) && stmt.body.every(stmtPure);
      }
      // FunctionDef, Global, NonLocal, FromImport, SimpleExpr, Assert,
      // FileInput — unsupported in a pure body.
      return false;
    };

    const pure = fd.body.every(stmtPure);

    const prev = unit.hints.get(fd) ?? {};
    if (prev[PURE_FIELD] === pure) return;
    const nextHint: OptimizationHint = { ...prev, [PURE_FIELD]: pure };
    unit.hints.set(fd, nextHint);
  }
}
