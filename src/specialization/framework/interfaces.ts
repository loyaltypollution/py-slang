import type { ExprNS } from "../../ast-types";
import type { FactStore } from "./fact-store";
import type { SlotLookup } from "./slot-table";

/** Expression-level DFA module for block-fixpoint analyses. */
export interface AnalysisPass<L> {
  readonly name: string;
  top(): L;
  bottom(): L;
  join(a: L, b: L): L;
  meet(a: L, b: L): L;
  leq(a: L, b: L): boolean;
  readonly mergeKind: "may" | "must";
  readonly direction: "forward" | "backward";

  /** Per-subtree visitor: reads from `env`, writes facts via `factStore`. */
  makeExprVisitor(
    factStore: FactStore,
    env: { get(slot: number): L | undefined },
    slotLookup: SlotLookup,
  ): ExprNS.Visitor<L>;
}
