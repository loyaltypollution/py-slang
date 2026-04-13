import type { ExprNS } from "../../ast-types";
import type { FactStore } from "./fact-store";
import type { SlotLookup } from "./slot-table";

/**
 * Expression-level dataflow analysis pass. The `name` doubles as a stable
 * identifier for logging. Runs as a Kildall fixpoint over basic blocks
 * within a `FunctionUnit`.
 *
 * Scope-level passes (purity, call-count) and transforms (dead-branch,
 * constant-folding, memoization) are `Pass<K, V>` instances colocated
 * with their analysis/transform modules.
 */
export interface AnalysisPass<L> {
  readonly name: string;
  top(): L;
  bottom(): L;
  join(a: L, b: L): L;
  meet(a: L, b: L): L;
  leq(a: L, b: L): boolean;
  readonly mergeKind: "may" | "must";
  readonly direction: "forward" | "backward";

  /**
   * Create the expression-level visitor for this analysis. The DFA driver
   * calls this per expression sub-tree; the returned visitor reads from
   * `env` and writes computed facts via the shared `FactStore`.
   */
  makeExprVisitor(
    factStore: FactStore,
    env: { get(slot: number): L | undefined },
    slotLookup: SlotLookup,
  ): ExprNS.Visitor<L>;
}
