import type { ExprNS } from "../../ast-types";
import type { FactStore } from "./fact-store";
import type { SlotLookup } from "./slot-table";

/**
 * Expression-level dataflow analysis pass. The `name` doubles as a stable
 * identifier for logging. Runs as a Kildall fixpoint over basic blocks
 * within a `FunctionUnit`.
 *
 * Scope-level passes (purity, call-count) and transforms (dead-branch,
 * constant-folding, memoization) are `Pass<K, V>` instances in
 * `migrated-passes.ts`.
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
   * `env` and writes computed facts via the shared `FactStore`.
   */
  makeExprVisitor(
    factStore: FactStore,
    env: { get(slot: number): L | undefined },
    slotLookup: SlotLookup,
    /** When supplied, visitor emits via tap; the legacy fact-store write is skipped. */
    tap?: (id: number, val: L) => void,
  ): ExprNS.Visitor<L>;

  /**
   * Fold a raw runtime value (pushed by an interpreter on a slot write) into
   * the corresponding fact cell. Must use `join` semantics — observations
   * widen the set of seen values, they never narrow static facts. No-op when
   * the value is not useful for this analysis (e.g. ConstAnalysisPass ignores
   * non-primitive JS values rather than widening to TOP).
   */
  observeWrite?(factStore: FactStore, id: number, rawValue: unknown): void;
}
