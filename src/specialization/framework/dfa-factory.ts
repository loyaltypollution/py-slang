import type { BasicBlock } from "./cfg";
import type { FunctionUnit } from "./function-unit";
import { MutableEnv } from "./mutable-env";
import type { Lattice, Pass, PassCtx } from "./pass";
import { structuralPass } from "./structural-pass";
import { makeView, type View } from "./view";

/**
 * Packages a Kildall-style block DFA into the framework. Produces:
 *
 *   - `blockKeyedPass: Pass<BasicBlock, MutableEnv<L>>` — fixpoint state. The
 *     block's OUT env. Lattice-equals gates downstream wakes; on a closed
 *     gate, every per-node value derivable from this block is unchanged
 *     (monotone determinism), so no separate per-node pass is needed.
 *   - `nodeFactView: View<NodeId, L>` — pure projection. On `get`, locates
 *     the block containing the node, reconstitutes the IN env from
 *     predecessors, and replays the configured `projectNode` to extract
 *     the value at that program point. No fact-store cells of its own.
 *
 * `transferBlock` and `projectNode` MUST be pure: no `factStore.write`,
 * no mutation of `unit`. Side-effect writes from inside these functions
 * bypass the lattice-equals gate and reopen the spurious-wake bug class
 * the framework exists to prevent.
 */

export type DfaDirection = "forward" | "backward";

export interface DfaConfig<L> {
  readonly debugName: string;
  readonly direction: DfaDirection;
  readonly bottom: L;
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
  /** Pure: replay the transfer up to `nodeId` in `block`, return its lattice value. */
  readonly projectNode: (
    ctx: PassCtx,
    unit: FunctionUnit,
    nodeId: number,
    inEnv: MutableEnv<L>,
    block: BasicBlock,
  ) => L | undefined;
  readonly reads: ReadonlyArray<Pass<any, any>>;
}

export interface DfaPasses<L> {
  readonly blockKeyedPass: Pass<BasicBlock, MutableEnv<L>>;
  readonly nodeFactView: View<number, L>;
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

  const blockKeyedPass: Pass<BasicBlock, MutableEnv<L>> = {
    id: blockPassId,
    debugName: `${config.debugName}:blocks`,
    lattice: envLattice,
    reads: [...config.reads, structuralPass],
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
      // Other reads (runtimeWritePass, etc.): coarse — re-run all blocks of
      // the affected unit. Tightening is a per-pass follow-on.
      const allBlocks: BasicBlock[] = [];
      for (const u of ctx.readAll(structuralPass).keys()) {
        for (const b of (u as FunctionUnit).cfg.blocks) allBlocks.push(b);
      }
      return allBlocks;
    },
    prune(_ctx, _unit, previousKeys) {
      // On structural change, all old BasicBlock identities are stale.
      return Array.from(previousKeys);
    },
  };

  const nodeFactView: View<number, L> = makeView(
    `${config.debugName}:nodes`,
    (ctx, nodeId) => {
      // Walk every unit's blockOfNode until we find the one that owns nodeId.
      // Cheap: each unit's blockOfNode is a hash lookup; the outer loop
      // terminates at the first hit. If this becomes hot, cache nodeId→unit.
      for (const unit of ctx.readAll(structuralPass).keys()) {
        const u = unit as FunctionUnit;
        const block = u.blockOfNode.get(nodeId);
        if (block === undefined) continue;
        const inEnv = inEnvFor(ctx, block, u);
        const v = config.projectNode(ctx, u, nodeId, inEnv, block);
        return v ?? config.bottom;
      }
      return config.bottom;
    },
  );

  return { blockKeyedPass, nodeFactView };
}
