import type { BasicBlock } from "./cfg";
import type { FactStore } from "./fact-store";
import type { FunctionUnit } from "./function-unit";
import { MutableEnv } from "./mutable-env";
import type { Lattice, Pass, PassCtx } from "./pass";
import { structuralPass } from "./structural-pass";

/** Packages a Kildall block DFA as a `Pass<BasicBlock, DfaBlockFact<L>>`.
 *  The fact carries both the block's OUT env (used for CFG successor
 *  propagation) and the per-expression lattice facts the transfer computed
 *  inside this block. Per-node facts are queried via `readExprFact` — they
 *  live inside the block fact rather than in a side-channel per-node pass. */

/** Output fact for one block under an analysis pass. */
export interface DfaBlockFact<L> {
  /** Slot-keyed OUT env for forward successor / backward predecessor merging. */
  readonly outEnv: MutableEnv<L>;
  /** NodeId → lattice value for expressions visited in this block's transfer. */
  readonly exprFacts: ReadonlyMap<number, L>;
}

type DfaDirection = "forward" | "backward";

interface DfaConfig<L> {
  readonly debugName: string;
  readonly direction: DfaDirection;
  readonly top: L;
  readonly leq: (a: L, b: L) => boolean;
  readonly join: (a: L, b: L) => L;
  readonly meet: (a: L, b: L) => L;
  readonly mergeKind: "may" | "must";
  /** Pure: IN env → OUT env + per-node exprFacts. No fact-store writes. */
  readonly transferBlock: (
    ctx: PassCtx,
    block: BasicBlock,
    inEnv: MutableEnv<L>,
    unit: FunctionUnit,
  ) => DfaBlockFact<L>;
  /** Seed the entry (forward) / exit (backward) block's IN env. */
  readonly seedEnv: (unit: FunctionUnit) => MutableEnv<L>;
  readonly reads: ReadonlyArray<Pass<any, any>>;
}

export function makeBlockFixpointPass<L>(
  config: DfaConfig<L>,
): Pass<BasicBlock, DfaBlockFact<L>> {
  const bottomFact: DfaBlockFact<L> = {
    outEnv: new MutableEnv<L>(),
    exprFacts: new Map<number, L>(),
  };

  const exprFactsEqual = (
    a: ReadonlyMap<number, L>,
    b: ReadonlyMap<number, L>,
  ): boolean => {
    if (a === b) return true;
    if (a.size !== b.size) return false;
    for (const [k, va] of a) {
      const vb = b.get(k);
      if (vb === undefined) return false;
      if (!config.leq(va, vb) || !config.leq(vb, va)) return false;
    }
    return true;
  };

  const exprFactsJoin = (
    a: ReadonlyMap<number, L>,
    b: ReadonlyMap<number, L>,
  ): ReadonlyMap<number, L> => {
    if (a === b || a.size === 0) return b;
    if (b.size === 0) return a;
    const merged = new Map<number, L>(a);
    for (const [k, vb] of b) {
      const va = merged.get(k);
      merged.set(k, va === undefined ? vb : config.join(va, vb));
    }
    return merged;
  };

  const envLattice: Lattice<DfaBlockFact<L>> = {
    bottom: bottomFact,
    // Both parts of the fact participate in equality: a block whose stmts
    // produce no slot writes (e.g. bare `return e`) has an invariant outEnv,
    // but runtime observations widen the per-expression lattice inside `e` —
    // readers of the per-node projection must wake on those.
    equals: (a, b) =>
      a.outEnv.equals(b.outEnv, config.leq) && exprFactsEqual(a.exprFacts, b.exprFacts),
    // Commutative monotone join: outEnv merges slot-wise, exprFacts merge
    // per-nodeId. Under the DFA's expected monotone transfer, FactStore.write's
    // join(prev, new) collapses to `new`; commutativity makes that independent
    // of operand order.
    join: (a, b) => {
      const merged = a.outEnv.snapshot();
      if (config.mergeKind === "must") {
        merged.meetWith(b.outEnv, config.meet, config.top);
      } else {
        merged.joinWith(b.outEnv, config.join);
      }
      return { outEnv: merged, exprFacts: exprFactsJoin(a.exprFacts, b.exprFacts) };
    },
  };

  const blockPassId = Symbol(`${config.debugName}:blocks`);

  function inEnvFor(ctx: PassCtx, block: BasicBlock, unit: FunctionUnit): MutableEnv<L> {
    const preds = config.direction === "forward" ? block.predecessors : block.successors;
    if (preds.length === 0) return config.seedEnv(unit);
    let env: MutableEnv<L> | undefined;
    for (const pred of preds) {
      const predOut = ctx.read(blockKeyedPass, pred).outEnv;
      if (env === undefined) {
        env = predOut.snapshot();
      } else {
        if (config.mergeKind === "must") {
          env.meetWith(predOut, config.meet, config.top);
        } else {
          env.joinWith(predOut, config.join);
        }
      }
    }
    return env ?? config.seedEnv(unit);
  }

  // Self-reference appended below so block-OUT changes wake CFG-successors.
  const readsArr: Pass<any, any>[] = [...config.reads, structuralPass];
  // eslint-disable-next-line prefer-const
  let blockKeyedPass: Pass<BasicBlock, DfaBlockFact<L>>;
  blockKeyedPass = {
    id: blockPassId,
    debugName: `${config.debugName}:blocks`,
    lattice: envLattice,
    reads: readsArr,
    tier: "analysis",
    coarse: false,
    transfer(ctx: PassCtx, block: BasicBlock): DfaBlockFact<L> | undefined {
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

/** Resolve a per-expression fact from the DFA block pass.
 *  `block` must be the BasicBlock that contains `nodeId` in the unit whose
 *  `transferBlock` visited this expression — usually `unit.blockOfNode.get(nodeId)`
 *  where `unit` is the innermost unit containing the node. */
export function readExprFact<L>(
  factStore: FactStore,
  pass: Pass<BasicBlock, DfaBlockFact<L>>,
  block: BasicBlock | undefined,
  nodeId: number,
): L | undefined {
  if (block === undefined) return undefined;
  return factStore.tryRead(pass, block)?.exprFacts.get(nodeId);
}
