// src/specialization/memoization-analysis/analysis.ts
//
// MemoizationAnalysisModule — accumulates a saturating per-FunctionDef call
// count by hooking the worklist's `observeCall` path via the optional
// `onCallObservation` lifecycle method. Does not participate in normal
// expression-level DFA: the module's expression visitor returns a dummy
// lattice element, and the transfer function in the worklist never writes
// anything useful. All interesting work happens in `onCallObservation`.
//
// The count is stored as a plain number on the callee FunctionDef's
// `OptimizationHint` under the field `callCount`, so `MemoizationTransformRule`
// can read it with `hints.get(fd)?.callCount`. Counter saturates at
// `MEMOIZATION_THRESHOLD + 1` so the hint never grows unboundedly.

import { ExprNS, StmtNS } from "../../ast-types";
import type { AnalysisModule } from "../framework/interfaces";
import type { HintStore, OptimizationHint } from "../framework/hint";
import type { SlotLookup } from "../framework/slot-table";

/** Number of recorded calls after which MemoizationTransformRule may fire. */
export const MEMOIZATION_THRESHOLD = 10;

/** Name of the open-record hint field this analysis writes to. */
export const CALL_COUNT_FIELD = "callCount";

/** Hint field the transform sets on a FunctionDef after wrapping it. */
export const MEMOIZED_FIELD = "memoized";

// Lattice is just a saturating natural number.
type Count = number;

class MemoizationVisitor implements ExprNS.Visitor<Count> {
  // Every visit returns the module bottom — this analysis does not derive
  // facts from expression shape, only from call observations.
  private ret(): Count { return 0; }
  visitBigIntLiteralExpr(): Count { return this.ret(); }
  visitBinaryExpr(e: ExprNS.Binary): Count { e.left.accept(this); e.right.accept(this); return this.ret(); }
  visitCompareExpr(e: ExprNS.Compare): Count { e.left.accept(this); e.right.accept(this); return this.ret(); }
  visitBoolOpExpr(e: ExprNS.BoolOp): Count { e.left.accept(this); e.right.accept(this); return this.ret(); }
  visitGroupingExpr(e: ExprNS.Grouping): Count { e.expression.accept(this); return this.ret(); }
  visitLiteralExpr(): Count { return this.ret(); }
  visitUnaryExpr(e: ExprNS.Unary): Count { e.right.accept(this); return this.ret(); }
  visitTernaryExpr(e: ExprNS.Ternary): Count {
    e.predicate.accept(this); e.consequent.accept(this); e.alternative.accept(this); return this.ret();
  }
  visitLambdaExpr(): Count { return this.ret(); }
  visitMultiLambdaExpr(): Count { return this.ret(); }
  visitVariableExpr(): Count { return this.ret(); }
  visitCallExpr(e: ExprNS.Call): Count {
    e.callee.accept(this);
    for (const a of e.args) a.accept(this);
    return this.ret();
  }
  visitListExpr(e: ExprNS.List): Count {
    for (const el of e.elements) el.accept(this);
    return this.ret();
  }
  visitSubscriptExpr(e: ExprNS.Subscript): Count {
    e.value.accept(this); e.index.accept(this); return this.ret();
  }
  visitStarredExpr(e: ExprNS.Starred): Count { e.value.accept(this); return this.ret(); }
  visitNoneExpr(): Count { return this.ret(); }
  visitComplexExpr(): Count { return this.ret(); }
}

export class MemoizationAnalysisModule implements AnalysisModule<Count> {
  readonly name = CALL_COUNT_FIELD;
  readonly mergeKind = "may" as const;
  readonly direction = "forward" as const;

  latticeEquals(a: unknown, b: unknown): boolean {
    return (a as Count) === (b as Count);
  }
  top(): Count { return MEMOIZATION_THRESHOLD + 1; }
  bottom(): Count { return 0; }
  join(a: Count, b: Count): Count { return Math.max(a, b); }
  meet(a: Count, b: Count): Count { return Math.min(a, b); }
  leq(a: Count, b: Count): boolean { return a <= b; }

  makeExprVisitor(
    _hints: HintStore,
    _env: { get(slot: number): Count | undefined },
    _slotLookup: SlotLookup,
  ): ExprNS.Visitor<Count> {
    return new MemoizationVisitor();
  }

  /**
   * Bump the callee's saturating call counter. The counter lives on the
   * callee FunctionDef's hint (keyed by its node.id); MemoizationTransformRule
   * reads it back via `hints.get(fd)?.callCount`.
   */
  onCallObservation(
    _callerKey: StmtNS.FileInput | StmtNS.FunctionDef,
    calleeKey: StmtNS.FileInput | StmtNS.FunctionDef,
    calleeHints: HintStore,
  ): void {
    // Only count calls to user-defined FunctionDefs — FileInput-as-callee
    // would mean the top-level scope is being "called", which is nonsensical
    // here and never eligible for memoization.
    if (!(calleeKey instanceof StmtNS.FunctionDef)) return;
    const prev = calleeHints.get(calleeKey) ?? {};
    const prevCount = typeof prev[CALL_COUNT_FIELD] === "number" ? (prev[CALL_COUNT_FIELD] as number) : 0;
    // Saturate — avoid growing the hint without bound under hot loops.
    const next = Math.min(prevCount + 1, MEMOIZATION_THRESHOLD + 1);
    if (next === prevCount) return;
    const nextHint: OptimizationHint = { ...prev, [CALL_COUNT_FIELD]: next };
    calleeHints.set(calleeKey, nextHint);
  }
}
