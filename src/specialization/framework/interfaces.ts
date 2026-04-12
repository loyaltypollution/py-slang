import type { ExprNS, StmtNS } from "../../ast-types";
import type { SlotLookup } from "./slot-table";
import type { HintStore, OptimizationHint } from "./hint";

export interface StmtTransformRule {
  readonly name: string;
  readonly level: "stmt";
  matches(stmt: StmtNS.Stmt, hints: HintStore): boolean;
  /** Returns replacement statements. Empty array = delete the statement. */
  apply(stmt: StmtNS.Stmt, hints: HintStore): StmtNS.Stmt[];
}

export interface ExprTransformRule {
  readonly name: string;
  readonly level: "expr";
  matches(expr: ExprNS.Expr, hints: HintStore): boolean;
  /** Returns replacement expression (1:1). */
  apply(expr: ExprNS.Expr, hints: HintStore): ExprNS.Expr;
}

export type TransformRule = StmtTransformRule | ExprTransformRule;

export interface AnalysisModule<L> {
  readonly name: string;
  top(): L;
  bottom(): L;
  join(a: L, b: L): L;
  meet(a: L, b: L): L;
  leq(a: L, b: L): boolean;
  readonly mergeKind: "may" | "must";
  readonly direction: "forward" | "backward";

  /**
   * Create the expression-level visitor for this analysis.
   * The DFA driver calls this per expression sub-tree; the returned visitor
   * reads from `env` and writes computed facts to `hints`.
   */
  makeExprVisitor(
    hints: HintStore,
    env: { get(slot: number): L | undefined },
    slotLookup: SlotLookup,
  ): ExprNS.Visitor<L>;

  /**
   * Map a raw runtime value (pushed by an interpreter on a slot write) to a
   * lattice element of this analysis. Return `undefined` to ignore the value
   * (e.g. ConstAnalysisModule returns `undefined` for non-primitive JS values
   * rather than widening the hint to TOP).
   */
  observeValue?(rawValue: unknown): L | undefined;

  /**
   * Merge a lattice element produced by `observeValue` into the node's hint.
   * Must use `join` semantics — observations widen the set of seen values,
   * they never narrow static facts (narrowing would be unsound for
   * specialization consumers).
   */
  mergeIntoHint?(hint: OptimizationHint, value: L): OptimizationHint;
}
