import type { BasicBlock } from "./cfg";
import type { FunctionUnit } from "./function-unit";
import { MutableEnv } from "./mutable-env";
import type { Lattice, Pass, PassCtx } from "./pass";
import { structuralPass } from "./structural-pass";

/**
 * Packages a Kildall-style block DFA into the framework. Produces:
 *
 *   - `blockKeyedPass: Pass<BasicBlock, MutableEnv<L>>` — fixpoint state. The
 *     block's OUT env. Lattice-equals gates downstream wakes; on a closed
 *     gate, every per-node value derivable from this block is unchanged
 *     (monotone determinism), so no separate per-node pass is needed.
 *
 * `transferBlock` MUST be pure: no `factStore.write`, no mutation of
 * `unit`. Side-effect writes from inside this function bypass the
 * lattice-equals gate and reopen the spurious-wake bug class the
 * framework exists to prevent.
 */

export type DfaDirection = "forward" | "backward";

export interface DfaConfig<L> {
  readonly debugName: string;
  readonly direction: DfaDirection;
  readonly top: L;
  readonly leq: (a: L, b: L) => boolean;
  readonly join: (a: L, b: L) => L;
  readonly meet: (a: L, b: L) => L;
  readonly mergeKind: "may" | "must";
  /** Pure: take IN env, return OUT env. No fact-store writes, no unit mutation. */
  readonly transferBlock: (
    ctx: PassCtx,
    block: BasicBlock,
    inEnv: MutableEnv<L>,
    unit: FunctionUnit,
  ) => MutableEnv<L>;
  /** Seed the entry (forward) / exit (backward) block's IN env. */
  readonly seedEnv: (unit: FunctionUnit) => MutableEnv<L>;
  readonly reads: ReadonlyArray<Pass<any, any>>;
}

export interface DfaPasses<L> {
  readonly blockKeyedPass: Pass<BasicBlock, MutableEnv<L>>;
}

function predecessors(block: BasicBlock, direction: DfaDirection): BasicBlock[] {
  return direction === "forward" ? block.predecessors : block.successors;
}

function successors(block: BasicBlock, direction: DfaDirection): BasicBlock[] {
  return direction === "forward" ? block.successors : block.predecessors;
}

export function makeBlockFixpointPass<L>(config: DfaConfig<L>): DfaPasses<L> {
  const envLattice: Lattice<MutableEnv<L>> = {
    bottom: new MutableEnv<L>(),
    equals: (a, b) => a.equals(b, config.leq),
    join: (a, b) => {
      const merged = a.snapshot();
      if (config.mergeKind === "must") {
        merged.meetWith(b, config.meet, config.top);
      } else {
        merged.joinWith(b, config.join);
      }
      return merged;
    },
  };

  const blockPassId = Symbol(`${config.debugName}:blocks`);

  function inEnvFor(ctx: PassCtx, block: BasicBlock, unit: FunctionUnit): MutableEnv<L> {
    const preds = predecessors(block, config.direction);
    if (preds.length === 0) return config.seedEnv(unit);
    let env: MutableEnv<L> | undefined;
    for (const pred of preds) {
      const predOut = ctx.read(blockKeyedPass, pred);
      env = env === undefined ? predOut.snapshot() : envLattice.join(env, predOut);
    }
    return env ?? config.seedEnv(unit);
  }

  // Forward-reference pattern: `reads` must include the pass itself so
  // block-OUT changes wake CFG-successors through the dispatch graph. The
  // array is built first, populated with the self-reference after the pass
  // object exists, then frozen. ReadonlyArray contract preserved.
  const readsArr: Pass<any, any>[] = [...config.reads, structuralPass];
  // eslint-disable-next-line prefer-const
  let blockKeyedPass: Pass<BasicBlock, MutableEnv<L>>;
  blockKeyedPass = {
    id: blockPassId,
    debugName: `${config.debugName}:blocks`,
    lattice: envLattice,
    reads: readsArr,
    tier: "analysis",
    coarse: false,
    transfer(ctx: PassCtx, block: BasicBlock): MutableEnv<L> | undefined {
      const unit = ctx.unitForBlock(block);
      if (unit === undefined) return undefined;
      const inEnv = inEnvFor(ctx, block, unit);
      return config.transferBlock(ctx, block, inEnv, unit);
    },
    affectedKeys(ctx, triggerPass, triggerKey) {
      // Self-wake: a block's OUT changing wakes its CFG-successors so they
      // recompute IN. Direction-aware.
      if ((triggerPass as Pass<any, any>) === (blockKeyedPass as Pass<any, any>)) {
        return successors(triggerKey as BasicBlock, config.direction);
      }
      // Structural: seed only the entry block; self-wake walks the CFG.
      if ((triggerPass as Pass<any, any>) === (structuralPass as Pass<any, any>)) {
        const unit = triggerKey as FunctionUnit;
        const seed = config.direction === "forward" ? unit.cfg.entry : unit.cfg.exit;
        return [seed];
      }
      // Other reads (runtimeWritePass, etc.): precise mapping. triggerKey is
      // a NodeId; resolve via the structural `unitForNode` lookup — does not
      // depend on any pass having produced facts yet, so `observe()` calls
      // made before `converge()` still fan out correctly.
      if (typeof triggerKey === "number") {
        const unit = ctx.unitForNode(triggerKey);
        const block = unit?.blockOfNode.get(triggerKey);
        if (block !== undefined) return [block];
      }
      return [];
    },
    prune(ctx, _unit, previousKeys) {
      // BlockId is a per-CFG counter from 0, so ids collide across units —
      // filtering by id would evict live sibling-unit cells. rebuildStructural
      // swaps unit.blockMap before the structuralPass write, so at prune time
      // orphaned (stale) blocks are exactly those no unit owns by identity.
      return Array.from(previousKeys).filter(k => ctx.unitForBlock(k) === undefined);
    },
  };

  // Self-wake: block OUT changes propagate to CFG-successors (handled in affectedKeys).
  readsArr.push(blockKeyedPass);
  Object.freeze(readsArr);

  return { blockKeyedPass };
}
