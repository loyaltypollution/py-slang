import type { ExprNS } from "../../ast-types";
import type { FactStore } from "./fact-store";
import type { SlotLookup } from "./slot-table";

/** Read-only slot → lattice-value view (the minimum a visitor needs from `MutableEnv<L>`). */
export interface SlotEnv<L> {
  get(slot: number): L | undefined;
}

/** Expression-level DFA module for block-fixpoint analyses. */
export interface AnalysisPass<L> {
  top(): L;
  bottom(): L;
  join(a: L, b: L): L;
  meet(a: L, b: L): L;
  leq(a: L, b: L): boolean;
  readonly mergeKind: "may" | "must";
  readonly direction: "forward" | "backward";

  /** Per-subtree visitor. Reads upstream observations from `factStore`
   *  (read-only — `runtimeWritePass` lookups for lattice widening) and
   *  records per-node output facts into `recordExprFact`. The visitor MUST
   *  NOT write back into `factStore` — per-node facts flow out via
   *  `recordExprFact` and are attached to the block pass's `DfaBlockFact`
   *  by `transferBlock`. */
  makeExprVisitor(
    factStore: FactStore,
    env: SlotEnv<L>,
    slotLookup: SlotLookup,
    recordExprFact: (nodeId: number, val: L) => void,
  ): ExprNS.Visitor<L>;
}
