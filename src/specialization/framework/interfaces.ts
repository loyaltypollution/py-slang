import type { ExprNS } from "../../ast-types";
import type { FactStore } from "./fact-store";
import type { BoundedLattice } from "./pass";
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
 *      builds (or drops) the corresponding FunctionUnit and fires the
 *      `onUnitMinted` / `onUnitRetired` lifecycle event.
 *
 * The enclosing unit's CFG rebuild is handled automatically: the transform's
 * `sweep` returns `true`, and the worklist adds the mutated unit to
 * `pendingRebuilds` — no separate bookkeeping call required.
 *
 * Skipping step 2 is undefined behavior (stale slot map, missing unit) and
 * converts to a noisy throw at the first slot lookup — never silent miscompile.
 */

/** Read-only slot → lattice-value view (the minimum a visitor needs from `MutableEnv<L>`). */
export interface SlotEnv<L> {
  get(slot: number): L | undefined;
}

/** Expression-level DFA module for block-fixpoint analyses. Extends
 *  `BoundedLattice<L>` so the module itself IS the per-slot value lattice —
 *  no separate field, no duplication between `AnalysisPass` and the
 *  `valueLattice` passed to `makeBlockFixpointPass`. */
export interface AnalysisPass<L> extends BoundedLattice<L> {
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
