// src/specialization/runtime/queries/kildall.ts — forward Kildall iterator
//
// Standalone, pure, no Db/Query dependency. See DECISIONS.md §Phase 3 for
// why DFA runs as a single query body (Kildall internally) rather than the
// per-block self-recursive `cycle_fn` shape the architecture plan describes.

import type { BasicBlock, BlockId, CFG } from "../../framework/cfg";
import type { MutableEnv } from "../../framework/mutable-env";
import type { Lattice } from "../lattice";

const ITERATION_CAP = 10000;

/**
 * Forward-dataflow Kildall fixpoint.
 *
 * `lattice` operates on env-level values (join/equals/bottom). `initial`
 * is the entry block's IN env. `transferBlock` takes IN(b) and produces
 * OUT(b). The returned map is OUT(b) at fixpoint, immutable from the
 * caller's perspective (`ReadonlyMap`).
 *
 * The iteration cap guards against non-monotone transfer functions; it
 * throws rather than returning a partial result so the query layer can
 * surface the bug.
 */
export function kildall<L>(
  cfg: CFG,
  lattice: Lattice<MutableEnv<L>>,
  initial: MutableEnv<L>,
  transferBlock: (env: MutableEnv<L>, block: BasicBlock) => MutableEnv<L>,
): ReadonlyMap<BlockId, MutableEnv<L>> {
  const inEnv = new Map<BlockId, MutableEnv<L>>();
  const outEnv = new Map<BlockId, MutableEnv<L>>();

  for (const block of cfg.blocks) {
    inEnv.set(block.id, lattice.bottom);
    outEnv.set(block.id, lattice.bottom);
  }
  inEnv.set(cfg.entry.id, initial);

  const blockById = new Map<BlockId, BasicBlock>();
  for (const block of cfg.blocks) blockById.set(block.id, block);

  const worklist: BasicBlock[] = [...cfg.blocks];
  const inWorklist = new Set<BlockId>(cfg.blocks.map((b) => b.id));

  let iters = 0;
  while (worklist.length > 0) {
    if (iters++ > ITERATION_CAP) {
      throw new Error("Kildall iteration cap exceeded");
    }
    const block = worklist.shift() as BasicBlock;
    inWorklist.delete(block.id);

    // IN(b) = join over predecessors' OUT; entry block keeps `initial`.
    let currentIn: MutableEnv<L>;
    if (block === cfg.entry) {
      currentIn = initial;
    } else {
      currentIn = lattice.bottom;
      for (const pred of block.predecessors) {
        const predOut = outEnv.get(pred.id) as MutableEnv<L>;
        currentIn = lattice.join(currentIn, predOut);
      }
    }
    inEnv.set(block.id, currentIn);

    const newOut = transferBlock(currentIn, block);
    const oldOut = outEnv.get(block.id) as MutableEnv<L>;
    if (!lattice.equals(oldOut, newOut)) {
      outEnv.set(block.id, newOut);
      for (const succ of block.successors) {
        if (!inWorklist.has(succ.id)) {
          worklist.push(succ);
          inWorklist.add(succ.id);
        }
      }
    }
  }

  return outEnv;
}
