import type { ExprNS } from "../../ast-types";
import type { CFGEdge } from "./cfg";
import type { Context } from "./context";
import type { FactStore } from "./fact-store";
import type { MutableEnv } from "./mutable-env";
import type { BoundedLattice } from "./analysis";
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

/** Expression-level DFA module for block-fixpoint analyses. Extends
 *  `BoundedLattice<L>` so the module itself IS the per-slot value lattice —
 *  no separate field, no duplication between `BlockDfaSpec` and the
 *  `valueLattice` passed to `makeBlockFixpointAnalysis`. */
export interface BlockDfaSpec<L> extends BoundedLattice<L> {
  readonly mergeKind: "may" | "must";
  readonly direction: "forward" | "backward";

  /** Per-subtree visitor. Reads upstream observations from `factStore`
   *  (read-only — `runtimeWriteAnalysis` lookups for lattice widening) and
   *  records per-node output facts into `recordExprFact`. The visitor MUST
   *  NOT write back into `factStore` — per-node facts flow out via
   *  `recordExprFact` and are attached to the block analysis's `DfaBlockFact`
   *  by `transferBlock`.
   *
   *  `context` is the speculation context this transfer is running under.
   *  ROOT_CONTEXT for the unspeculated pass; a non-ROOT context carries
   *  assumption bindings the visitor MAY consult (via `findAssumption`) to
   *  narrow per-node facts. Modules that are speculation-oblivious ignore
   *  the parameter. */
  makeExprVisitor(
    factStore: FactStore,
    env: MutableEnv<L>,
    slotLookup: SlotLookup,
    recordExprFact: (nodeId: number, val: L) => void,
    context: Context,
  ): ExprNS.Visitor<L>;

  /** Per-edge env refinement. Called by the DFA factory before a predecessor
   *  block's OUT env is merged into the current block's IN env. Must be
   *  monotone: the returned env is ⊑ the input.
   *
   *  Contract: MUST NOT mutate `env` in place. To refine, `env.snapshot()`
   *  first, mutate the snapshot, and return it. To opt out of refinement,
   *  return `env` unchanged — the factory detects identity and elides a
   *  redundant snapshot.
   *
   *  Parallels `EdgeSpec.wake`: each analysis opts in by providing a body.
   *  Modules that don't narrow return `env` — identity is mandatory, not
   *  optional, to catch forgotten implementations at compile time. */
  refineOnEdge(env: MutableEnv<L>, edge: CFGEdge): MutableEnv<L>;
}
