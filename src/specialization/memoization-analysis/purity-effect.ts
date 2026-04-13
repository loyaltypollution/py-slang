// src/specialization/memoization-analysis/purity-effect.ts
//
// PurityEffectAnalysis — expression-level, lattice-based purity analysis.
// Annotates each Expr node with `pureEffect: "pure" | "impure"` on its
// OptimizationHint. Forward may-analysis; `join` widens toward "impure".
//
// Scope-level rules (no nested FunctionDef, Assign target must be local,
// self-recursive Call exemption) are applied by `PurityScopePass`, which
// folds these per-node marks into a single `pure: boolean` on the
// FunctionDef's hint.

import { ExprNS } from "../../ast-types";
import type { HintStore } from "../framework/hint";
import type { AnalysisPass } from "../framework/interfaces";
import type { SlotLookup } from "../framework/slot-table";

export type PureEffect = "pure" | "impure";

export const PURE: PureEffect = "pure";
export const IMPURE: PureEffect = "impure";

/** Open hint field written by this pass. */
export const PURE_EFFECT_FIELD = "pureEffect";

/** Flat lattice: pure ⊏ impure. Join widens. */
export function joinEffect(a: PureEffect, b: PureEffect): PureEffect {
  return a === IMPURE || b === IMPURE ? IMPURE : PURE;
}

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
    // A variable read is pure iff the name resolves to a local slot.
    // Non-local / primitive (global) reads are impure — a global can be
    // reassigned between calls, turning a cache hit into a stale read.
    const info = this.slotLookup(e.name);
    if (info.isPrimitive) return this.annotate(e, IMPURE);
    if (info.envLevel !== 0) return this.annotate(e, IMPURE);
    const slotEffect = this.env.get(info.slot);
    // Missing slot = bottom (PURE). Either a parameter at function
    // entry (no Assign has widened this slot yet) or a local whose
    // predecessor OUT has not yet propagated. The may-analysis join
    // will widen the slot to IMPURE if any predecessor's RHS is
    // impure; fixpoint convergence guarantees we eventually observe
    // that widening.
    return this.annotate(e, slotEffect ?? PURE);
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

  // Calls are always impure at the expression level — cross-function
  // purity summaries are out of scope here. PurityScopePass re-checks
  // self-recursion as a structural exemption.
  visitCallExpr(e: ExprNS.Call): PureEffect {
    e.callee.accept(this);
    for (const a of e.args) a.accept(this);
    return this.annotate(e, IMPURE);
  }

  // Structurally impure — cannot be observed pure at the expression level.
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
  join(a: PureEffect, b: PureEffect): PureEffect {
    return joinEffect(a, b);
  }
  meet(a: PureEffect, b: PureEffect): PureEffect {
    return a === PURE || b === PURE ? PURE : IMPURE;
  }
  leq(a: PureEffect, b: PureEffect): boolean {
    return a === b || a === PURE;
  }

  makeExprVisitor(
    hints: HintStore,
    env: { get(slot: number): PureEffect | undefined },
    slotLookup: SlotLookup,
  ): ExprNS.Visitor<PureEffect> {
    return new PurityEffectVisitor(hints, env, slotLookup);
  }

  // No `observeValue` / `mergeIntoHint`: purity is a static property of
  // the AST, not something observable from runtime values. The framework
  // filters out passes missing either hook, so declaring one without the
  // other would be dead code.
}
