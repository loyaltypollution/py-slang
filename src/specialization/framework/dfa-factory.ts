import type { BasicBlock } from "./cfg";
import type { FactStore } from "./fact-store";
import type { FunctionUnit } from "./function-unit";
import { MutableEnv } from "./mutable-env";
import { latticeEquals, type BoundedLattice, type EdgeSpec, type Lattice, type Pass, type PassCtx } from "./pass";

/** Packages a Kildall block DFA as a `Pass<BasicBlock, DfaBlockFact<L>>`.
 *  The fact carries the block's OUT env (used for CFG successor propagation)
 *  and the per-node lattice facts the transfer computed inside this block.
 *  Analyses that need block-global sticky state (e.g. purity's "impure" bit)
 *  stash it in `exprFacts` at a sentinel nodeId — exprFacts is joined
 *  per-key via the value lattice, so the sentinel participates in the
 *  usual monotone propagation without a separate summary channel. */

/** Output fact for one block under an analysis pass. */
export interface DfaBlockFact<L> {
  /** Slot-keyed OUT env for forward successor / backward predecessor merging. */
  readonly outEnv: MutableEnv<L>;
  /** NodeId → lattice value for expressions visited in this block's transfer. */
  readonly exprFacts: ReadonlyMap<number, L>;
}

type DfaDirection = "forward" | "backward";

interface DfaConfigBase<L> {
  readonly debugName: string;
  readonly direction: DfaDirection;
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

/** May-merge analyses only need `Lattice<L>` (join + leq). Must-merge needs
 *  `BoundedLattice<L>` so the factory can call `meetWith(..., top)`. The
 *  discriminated union lets `purityBlockPass` (may-merge) pass a plain
 *  `Lattice` without fabricating unused `top`/`meet` — the type system
 *  refuses a must-merge config paired with a non-bounded lattice. */
type DfaConfig<L> = DfaConfigBase<L> & (
  | { readonly mergeKind: "may"; readonly valueLattice: Lattice<L> }
  | { readonly mergeKind: "must"; readonly valueLattice: BoundedLattice<L> }
);

export function makeBlockFixpointPass<L>(
  config: DfaConfig<L>,
): Pass<BasicBlock, DfaBlockFact<L>> {
  // Frozen singleton: `FactStore.read` returns this for unwritten cells. Any
  // caller that mutates `outEnv` or `exprFacts` in place corrupts every other
  // unwritten read through the same pass. `Object.freeze` prevents
  // re-assignment of the outer fields; `outEnv.freeze()` makes the internal
  // slot array mutators throw — callers MUST `snapshot()` before mutation.
  // `inEnvFor` does exactly that; `readExprFact` only reads via `tryRead`/
  // `.get`, which never touches the bottom object.
  const bottomFact: DfaBlockFact<L> = Object.freeze({
    outEnv: new MutableEnv<L>().freeze(),
    exprFacts: new Map<number, L>(),
  });

  const exprFactsJoin = (
    a: ReadonlyMap<number, L>,
    b: ReadonlyMap<number, L>,
  ): ReadonlyMap<number, L> => {
    if (a === b || a.size === 0) return b;
    if (b.size === 0) return a;
    const merged = new Map<number, L>(a);
    for (const [k, vb] of b) {
      const va = merged.get(k);
      merged.set(k, va === undefined ? vb : config.valueLattice.join(va, vb));
    }
    return merged;
  };

  // Pointwise `a ⊑ b`. Missing keys are ⊥; the `a.size === 0` shortcut
  // handles the common case where a freshly-built fact is compared against
  // an established one.
  const exprFactsLeq = (
    a: ReadonlyMap<number, L>,
    b: ReadonlyMap<number, L>,
  ): boolean => {
    if (a === b || a.size === 0) return true;
    for (const [k, va] of a) {
      const vb = b.get(k);
      if (vb === undefined) return false;
      if (!config.valueLattice.leq(va, vb)) return false;
    }
    return true;
  };

  // Both parts participate in change detection — exprFacts can advance while
  // outEnv stays invariant (e.g. runtime observation widening a sub-expression
  // in `return e`), and readers of any projection must wake on those. Ripple
  // cost is bounded: a change to exprFacts alone still wakes CFG successors
  // via the self-reader edge, but each successor's transfer then produces an
  // unchanged OUT, so the ripple dies after one hop per successor — O(|CFG|)
  // per observation.
  const compoundLeq = (a: DfaBlockFact<L>, b: DfaBlockFact<L>): boolean =>
    a.outEnv.leq(b.outEnv, config.valueLattice) &&
    exprFactsLeq(a.exprFacts, b.exprFacts);
  const envLattice: Lattice<DfaBlockFact<L>> = {
    bottom: bottomFact,
    leq: compoundLeq,
    // Commutative monotone join: outEnv merges slot-wise, exprFacts merge
    // per-nodeId via the value lattice. Under the DFA's expected monotone
    // transfer, FactStore.write's join(prev, new) collapses to `new`;
    // commutativity makes that independent of operand order.
    join: (a, b) => {
      const merged = a.outEnv.snapshot();
      if (config.mergeKind === "must") {
        merged.meetWith(b.outEnv, config.valueLattice);
      } else {
        merged.joinWith(b.outEnv, config.valueLattice);
      }
      return {
        outEnv: merged,
        exprFacts: exprFactsJoin(a.exprFacts, b.exprFacts),
      };
    },
  };

  const blockPassId = Symbol(`${config.debugName}:blocks`);

  function inEnvFor(ctx: PassCtx, block: BasicBlock, unit: FunctionUnit): MutableEnv<L> {
    const preds = config.direction === "forward" ? block.predecessors : block.successors;
    if (preds.length === 0) return config.seedEnv(unit);
    let env: MutableEnv<L> | undefined;
    for (const pred of preds) {
      // `ctx.read` returns the (frozen) bottomFact for unwritten cells. We
      // always `snapshot()` before mutating — never touch the shared outEnv
      // directly.
      const predOut = ctx.read(blockKeyedPass, pred).outEnv;
      if (env === undefined) {
        env = predOut.snapshot();
      } else {
        if (config.mergeKind === "must") {
          env.meetWith(predOut, config.valueLattice);
        } else {
          env.joinWith(predOut, config.valueLattice);
        }
      }
    }
    return env ?? config.seedEnv(unit);
  }

  // NodeId-keyed upstream → containing block in this unit.
  const nodeIdToBlock = (ctx: PassCtx, key: unknown): Iterable<BasicBlock> => {
    if (typeof key !== "number") return [];
    const u = ctx.unitForNode(key);
    const block = u?.blockOfNode.get(key);
    return block === undefined ? [] : [block];
  };

  // Config-supplied upstreams are node-fact sources (runtime observations,
  // node-keyed analyses). Project each to its containing block.
  const configEdges: EdgeSpec<BasicBlock>[] = config.reads.map(p => ({
    pass: p,
    wake: nodeIdToBlock,
  }));

  // `edges` is a live array passed to the pass; construct the pass first,
  // then push the self-edge referring to `blockKeyedPass` directly. Callers
  // with cross-pass cycles (e.g. purity block ↔ scope) amend `edges`
  // post-construction via `addEdge` for the same reason — the array stays
  // unfrozen to make that safe.
  const edgesArr: EdgeSpec<BasicBlock>[] = [...configEdges];

  const seedKey = (unit: FunctionUnit): BasicBlock =>
    config.direction === "forward" ? unit.cfg.entry : unit.cfg.exit;

  const blockKeyedPass: Pass<BasicBlock, DfaBlockFact<L>> = {
    id: blockPassId,
    debugName: `${config.debugName}:blocks`,
    lattice: envLattice,
    edges: edgesArr,
    tier: "analysis",
    transfer(ctx: PassCtx, block: BasicBlock): DfaBlockFact<L> | undefined {
      const unit = block.unit;
      const inEnv = inEnvFor(ctx, block, unit);
      return config.transferBlock(ctx, block, inEnv, unit);
    },
  };

  const evictStaleBlocks = (ctx: PassCtx, unit: FunctionUnit): void => {
    for (const b of ctx.factStore.readAll(blockKeyedPass).keys()) {
      if (b.unit === unit) ctx.factStore.evict(blockKeyedPass, b);
    }
  };

  // Lifecycle edges: seed entry/exit on mint, re-seed after rebuild (post
  // eviction of stale block cells), and drop stale blocks on retire. Block
  // cells are keyed by `BasicBlock` (not `FunctionUnit`), so the worklist's
  // universal unit-keyed eviction doesn't reach them; we do it here.
  edgesArr.push(
    { on: "mint", wake: (_ctx, unit) => [seedKey(unit)] },
    {
      on: "rebuild",
      wake: (_ctx, unit) => [seedKey(unit)],
      effect: evictStaleBlocks,
    },
    { on: "retire", effect: evictStaleBlocks },
  );

  // Self-wake: block OUT change → CFG successors recompute IN. Appended after
  // construction so we can reference `blockKeyedPass` directly, no getter.
  edgesArr.push({
    pass: blockKeyedPass as Pass<any, any>,
    wake: (_ctx, key) => {
      const b = key as BasicBlock;
      return config.direction === "forward" ? b.successors : b.predecessors;
    },
  });

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
