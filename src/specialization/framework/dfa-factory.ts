import type { BasicBlock } from "./cfg";
import type { FunctionUnit } from "./function-unit";
import { MutableEnv } from "./mutable-env";
import type { Lattice, Pass, PassCtx } from "./pass";
import { structuralPass } from "./structural-pass";

/** Packages a Kildall block DFA as a `Pass<BasicBlock, MutableEnv<L>>` over block OUT envs.
 *  `transferBlock` MUST be pure — block outputs flow through `processQueue`,
 *  not via side-channel `factStore.write` calls. FactStore now enforces
 *  monotonicity on writes, so a stray write won't corrupt the lattice; but it
 *  would still bypass the worklist's scheduling and dedup. */

type DfaDirection = "forward" | "backward";

interface DfaConfig<L> {
  readonly debugName: string;
  readonly direction: DfaDirection;
  readonly top: L;
  readonly leq: (a: L, b: L) => boolean;
  readonly join: (a: L, b: L) => L;
  readonly meet: (a: L, b: L) => L;
  readonly mergeKind: "may" | "must";
  /** Pure: IN env → OUT env. No fact-store writes. */
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

export function makeBlockFixpointPass<L>(config: DfaConfig<L>): Pass<BasicBlock, MutableEnv<L>> {
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
    const preds = config.direction === "forward" ? block.predecessors : block.successors;
    if (preds.length === 0) return config.seedEnv(unit);
    let env: MutableEnv<L> | undefined;
    for (const pred of preds) {
      const predOut = ctx.read(blockKeyedPass, pred);
      env = env === undefined ? predOut.snapshot() : envLattice.join(env, predOut);
    }
    return env ?? config.seedEnv(unit);
  }

  // Self-reference appended below so block-OUT changes wake CFG-successors.
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
      const unit = block.unit;
      const inEnv = inEnvFor(ctx, block, unit);
      return config.transferBlock(ctx, block, inEnv, unit);
    },
    affectedKeys(ctx, triggerPass, triggerKey) {
      // Self-wake: block OUT change → CFG successors recompute IN.
      if ((triggerPass as Pass<any, any>) === (blockKeyedPass as Pass<any, any>)) {
        const b = triggerKey as BasicBlock;
        return config.direction === "forward" ? b.successors : b.predecessors;
      }
      // Structural: seed entry/exit; self-wake walks the CFG.
      if ((triggerPass as Pass<any, any>) === (structuralPass as Pass<any, any>)) {
        const unit = triggerKey as FunctionUnit;
        const seed = config.direction === "forward" ? unit.cfg.entry : unit.cfg.exit;
        return [seed];
      }
      // NodeId trigger: map to containing block.
      if (typeof triggerKey === "number") {
        const unit = ctx.unitForNode(triggerKey);
        const block = unit?.blockOfNode.get(triggerKey);
        if (block !== undefined) return [block];
      }
      return [];
    },
    prune(_ctx, unit, previousKeys) {
      return Array.from(previousKeys).filter(k => k.unit === unit);
    },
  };

  readsArr.push(blockKeyedPass);
  Object.freeze(readsArr);

  return blockKeyedPass;
}
