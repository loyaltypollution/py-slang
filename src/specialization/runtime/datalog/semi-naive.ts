// src/specialization/runtime/datalog/semi-naive.ts
//
// Semi-naive fixpoint evaluator for monotone forward dataflow analyses.
//
// Scope and honest framing (from DECISIONS §Round 4 Phase 9-A):
// Under the plan's non-goals (monotone join only, single lattice,
// TypeScript closure transfer, no rule DSL, no negation) this evaluator
// is algorithmically identical to the existing `queries/kildall.ts`
// worklist. The wins over a direct Kildall call are:
//
//   1. Module boundary. `src/specialization/runtime/datalog/` is the
//      landing zone for future evaluator extensions (multi-lattice,
//      delete-rederive) that don't fit this scope.
//   2. `changedBlocks` return value. The dirty-set that accumulated
//      across the iteration is surfaced to the caller. Phase 9-E will
//      use this signal to drive per-block invalidation of downstream
//      `typeOf` / `constOf` projections.
//
// Bottom-initialize-everywhere is load-bearing (Phase 8's DFS-bottom
// trap stems from violating it). Every `outEnv[b]` starts at
// `lattice.bottom` before any transfer runs; predecessor reads during
// iteration can only return values monotonically ≥ bottom.

import type { BasicBlock, BlockId, CFG } from "../../framework/cfg";
import type { MutableEnv } from "../../framework/mutable-env";
import type { Lattice } from "../lattice";

const DEFAULT_ITERATION_CAP = 10000;

/**
 * Block transfer function. Takes IN(b) and a `BasicBlock`, returns OUT(b).
 * Pre-bind any auxiliary state (slotLookup, runtime observations, …) via
 * closure at the call site — the evaluator does not thread them through.
 */
export type BlockTransfer<L> = (
  env: MutableEnv<L>,
  block: BasicBlock,
) => MutableEnv<L>;

export interface SemiNaiveResult<L> {
  /** OUT(b) at fixpoint, keyed by BlockId. */
  readonly envs: ReadonlyMap<BlockId, MutableEnv<L>>;
  /**
   * Every BlockId whose OUT was written (strictly increased) at least
   * once during this run. Empty iff the call produced the same values
   * `lattice.bottom` at every block — i.e. nothing ran.
   */
  readonly changedBlocks: ReadonlySet<BlockId>;
}

export interface SemiNaiveOptions {
  readonly iterationCap?: number;
}

/**
 * Semi-naive forward-DFA fixpoint over a per-block env lattice. Returns
 * OUT(b) at fixpoint plus the set of blocks that changed during iteration.
 *
 * Throws on iteration-cap breach to surface non-monotone transfers.
 */
export function semiNaive<L>(
  cfg: CFG,
  lattice: Lattice<MutableEnv<L>>,
  initial: MutableEnv<L>,
  transferBlock: BlockTransfer<L>,
  opts?: SemiNaiveOptions,
): SemiNaiveResult<L> {
  const cap = opts?.iterationCap ?? DEFAULT_ITERATION_CAP;
  const outEnv = new Map<BlockId, MutableEnv<L>>();
  const blockById = new Map<BlockId, BasicBlock>();
  for (const block of cfg.blocks) {
    outEnv.set(block.id, lattice.bottom);
    blockById.set(block.id, block);
  }

  // Worklist: ordered set of block ids, seeded with every block in CFG
  // declaration order. Determinism comes from (a) the CFG builder's stable
  // block order and (b) preserving insertion order in the worklist array +
  // inWorklist guard.
  const worklist: BlockId[] = cfg.blocks.map((b) => b.id);
  const inWorklist = new Set<BlockId>(worklist);
  const changedBlocks = new Set<BlockId>();

  let iters = 0;
  while (worklist.length > 0) {
    if (iters++ > cap) {
      throw new Error("semiNaive iteration cap exceeded");
    }
    const blockId = worklist.shift() as BlockId;
    inWorklist.delete(blockId);
    const block = blockById.get(blockId) as BasicBlock;

    let inEnv: MutableEnv<L>;
    if (block === cfg.entry) {
      inEnv = initial;
    } else {
      inEnv = lattice.bottom;
      for (const pred of block.predecessors) {
        const predOut = outEnv.get(pred.id) as MutableEnv<L>;
        inEnv = lattice.join(inEnv, predOut);
      }
    }

    const newOut = transferBlock(inEnv, block);
    const oldOut = outEnv.get(blockId) as MutableEnv<L>;
    if (!lattice.equals(oldOut, newOut)) {
      outEnv.set(blockId, newOut);
      changedBlocks.add(blockId);
      for (const succ of block.successors) {
        if (!inWorklist.has(succ.id)) {
          worklist.push(succ.id);
          inWorklist.add(succ.id);
        }
      }
    }
  }

  return { envs: outEnv, changedBlocks };
}
