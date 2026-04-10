import type { ExprNS, StmtNS } from "../../ast-types";
import type { SlotLookup } from "../types";
import type { HintTable } from "./hint";

export interface StmtTransformRule {
  readonly name: string;
  readonly level: "stmt";
  matches(stmt: StmtNS.Stmt, hints: HintTable): boolean;
  /** Returns replacement statements. Empty array = delete the statement. */
  apply(stmt: StmtNS.Stmt, hints: HintTable): StmtNS.Stmt[];
}

export interface ExprTransformRule {
  readonly name: string;
  readonly level: "expr";
  matches(expr: ExprNS.Expr, hints: HintTable): boolean;
  /** Returns replacement expression (1:1). */
  apply(expr: ExprNS.Expr, hints: HintTable): ExprNS.Expr;
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
    hints: HintTable,
    env: readonly (L | undefined)[],
    slotLookup: SlotLookup,
  ): ExprNS.Visitor<L>;
}
