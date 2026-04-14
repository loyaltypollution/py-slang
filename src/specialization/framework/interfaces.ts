import type { ExprNS } from "../../ast-types";
import type { FactStore } from "./fact-store";
import type { SlotLookup } from "./slot-table";

/**
 * Structural-mutation contract for transforms.
 *
 * Function identity is owned by `FunctionRegistry` (fdId ↔ node ↔ slot).
 * Worklist and SVMLCompiler consume the registry; they do not re-derive slot
 * layout from AST traversal order. Any transform that adds or removes a
 * FunctionDef / Lambda / MultiLambda MUST cooperate with the registry or the
 * compiler and worklist diverge silently.
 *
 * Required steps, in order, inside a transform that mutates function structure:
 *
 *   1. Populate `functionEnvironments` for the new node (if adding).
 *   2. `registry.mint(newNode)` / `registry.retire(oldNode.id)` — this updates
 *      slot layout and fires the worklist's onMint/onRetire listener, which
 *      builds (or drops) the corresponding FunctionUnit and seeds (or evicts)
 *      its structuralPass fact.
 *   3. `worklist.markStructuralChange(enclosingFdId)` — wakes downstream
 *      passes for the enclosing scope whose body structurally changed. The
 *      registry knows *which* function was added/removed, not *where*; the
 *      enclosing-unit bump is the transform's responsibility.
 *
 * Skipping step 2 is undefined behavior (stale slot map, missing unit).
 * Skipping step 3 leaves downstream analyses observing stale per-node facts
 * for the enclosing body. Both convert to noisy throws at the first slot
 * lookup or pass re-transfer under the current contract — never silent
 * miscompile.
 */

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
