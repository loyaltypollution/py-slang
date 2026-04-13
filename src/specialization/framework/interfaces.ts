import type { ExprNS } from "../../ast-types";
import type { HintStore, OptimizationHint } from "./hint";
import type { SlotLookup } from "./slot-table";

/**
 * Expression-level dataflow analysis pass. The `name` doubles as the
 * hint-record field under which the analysis stores its lattice value.
 * Runs as a Kildall fixpoint over basic blocks within a `FunctionUnit`.
 *
 * Scope-level passes (purity, call-count) and transforms (dead-branch,
 * constant-folding, memoization) are now `Pass<K, V>` instances in
 * `migrated-passes.ts`. The `ScopePass` / `ScopeTransformRule` /
 * `StmtTransformRule` / `ExprTransformRule` / `TransformRule` interfaces
 * were deleted in PR-6.
 */
export interface AnalysisPass<L> {
  readonly name: string;
  latticeEquals(a: unknown, b: unknown): boolean;
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
   * `env` and writes computed facts to `hints`.
   */
  makeExprVisitor(
    hints: HintStore,
    env: { get(slot: number): L | undefined },
    slotLookup: SlotLookup,
  ): ExprNS.Visitor<L>;

  /**
   * Fold a raw runtime value (pushed by an interpreter on a slot write) into
   * the node's hint. Must use `join` semantics — observations widen the set
   * of seen values, they never narrow static facts (narrowing would be
   * unsound for specialization consumers). Return `hint` unchanged when the
   * value is not useful for this analysis (e.g. ConstAnalysisPass ignores
   * non-primitive JS values rather than widening to TOP).
   *
   * Paired with `ObservationSink.observeWrite` on the worklist side: the
   * sink's `observeWrite` is the runtime *event*; this method is the
   * per-analysis *reaction* that lifts the raw value into the lattice and
   * merges it into the hint in one step.
   */
  observeWrite?(hint: OptimizationHint, rawValue: unknown): OptimizationHint;
}
