import type { BasicBlock } from "./cfg";
import type { FactStore } from "./fact-store";
import type { FunctionUnit } from "./function-unit";
import { MutableEnv } from "./mutable-env";
import { latticeEquals, type BoundedLattice, type EdgeSpec, type Lattice, type Pass, type PassCtx } from "./pass";
import { structuralPass } from "./structural-pass";

/** Packages a Kildall block DFA as a `Pass<BasicBlock, DfaBlockFact<L, S>>`.
 *  The fact carries the block's OUT env (used for CFG successor propagation),
 *  the per-expression lattice facts the transfer computed inside this block,
 *  and an optional per-block *summary* lattice value `S` for analyses that
 *  track block-global facts orthogonal to the slot env (e.g. a sticky
 *  "impure" bit for purity analysis). `S` defaults to `void` — analyses that
 *  don't need summaries use the default and ignore it. Per-node facts are
 *  queried via `readExprFact` — they live inside the block fact rather than
 *  in a side-channel per-node pass. */

/** Output fact for one block under an analysis pass. */
export interface DfaBlockFact<L, S = void> {
  /** Slot-keyed OUT env for forward successor / backward predecessor merging. */
  readonly outEnv: MutableEnv<L>;
  /** NodeId → lattice value for expressions visited in this block's transfer. */
  readonly exprFacts: ReadonlyMap<number, L>;
  /** Block-global summary value (e.g. sticky flags). Defaults to `undefined`. */
  readonly summary: S;
}

type DfaDirection = "forward" | "backward";

interface DfaConfigBase<L, S> {
  readonly debugName: string;
  readonly direction: DfaDirection;
  /** Lattice for the per-block summary. Use `VOID_SUMMARY` for analyses that
   *  don't need one — it treats all values as equal and has `undefined` bottom. */
  readonly summaryLattice: Lattice<S>;
  /** Pure: IN env → OUT env + per-node exprFacts + per-block summary.
   *  The summary is *local* to this block — it is not seeded from predecessor
   *  OUT summaries. Consumers that want a whole-unit view (e.g. "any reachable
   *  block impure?") aggregate across `unit.cfg.blocks` in their own pass.
   *  For summaries that genuinely need flow-sensitivity, encode the relevant
   *  state inside `L` where the env's slot-wise join handles it. No
   *  fact-store writes. */
  readonly transferBlock: (
    ctx: PassCtx,
    block: BasicBlock,
    inEnv: MutableEnv<L>,
    unit: FunctionUnit,
  ) => DfaBlockFact<L, S>;
  /** Seed the entry (forward) / exit (backward) block's IN env. */
  readonly seedEnv: (unit: FunctionUnit) => MutableEnv<L>;
  readonly reads: ReadonlyArray<Pass<any, any>>;
}

/** May-merge analyses only need `Lattice<L>` (join + leq). Must-merge needs
 *  `BoundedLattice<L>` so the factory can call `meetWith(..., top)`. The
 *  discriminated union lets `purityBlockPass` (may-merge) pass a plain
 *  `Lattice` without fabricating unused `top`/`meet` — the type system
 *  refuses a must-merge config paired with a non-bounded lattice. */
type DfaConfig<L, S = void> = DfaConfigBase<L, S> & (
  | { readonly mergeKind: "may"; readonly valueLattice: Lattice<L> }
  | { readonly mergeKind: "must"; readonly valueLattice: BoundedLattice<L> }
);

/** No-op summary lattice for analyses that don't carry block-global state. */
export const VOID_SUMMARY: Lattice<void> = {
  bottom: undefined,
  leq: () => true,
  join: () => undefined,
};

export function makeBlockFixpointPass<L, S = void>(
  config: DfaConfig<L, S>,
): Pass<BasicBlock, DfaBlockFact<L, S>> {
  // Frozen singleton: `FactStore.read` returns this for unwritten cells. Any
  // caller that mutates `outEnv` or `exprFacts` in place corrupts every other
  // unwritten read through the same pass. `Object.freeze` prevents
  // re-assignment of the outer fields; `outEnv.freeze()` makes the internal
  // slot array mutators throw — callers MUST `snapshot()` before mutation.
  // `inEnvFor` does exactly that; `readExprFact` only reads via `tryRead`/
  // `.get`, which never touches the bottom object.
  const bottomFact: DfaBlockFact<L, S> = Object.freeze({
    outEnv: new MutableEnv<L>().freeze(),
    exprFacts: new Map<number, L>(),
    summary: config.summaryLattice.bottom,
  });

  const exprFactsEqual = (
    a: ReadonlyMap<number, L>,
    b: ReadonlyMap<number, L>,
  ): boolean => {
    if (a === b) return true;
    if (a.size !== b.size) return false;
    for (const [k, va] of a) {
      const vb = b.get(k);
      if (vb === undefined) return false;
      if (!latticeEquals(config.valueLattice, va, vb)) return false;
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
      merged.set(k, va === undefined ? vb : config.valueLattice.join(va, vb));
    }
    return merged;
  };

  // All three parts participate in change detection — exprFacts or summary
  // can advance while outEnv stays invariant (e.g. runtime observation
  // widening a sub-expression in `return e`), and readers of any projection
  // must wake on those. Ripple cost is bounded: a change to exprFacts/summary
  // alone still wakes CFG successors via the self-reader edge, but each
  // successor's transfer then produces an unchanged OUT, so the ripple dies
  // after one hop per successor — O(|CFG|) per observation.
  //
  // `leq` is conservative (= equals): a true point-wise leq would let
  // strictly-smaller writes skip `join` allocation, but the compound
  // structure makes that fiddly and the FactStore.write `latticeEquals`
  // backstop still suppresses the listener event for no-op writes.
  const compoundEquals = (a: DfaBlockFact<L, S>, b: DfaBlockFact<L, S>): boolean =>
    a.outEnv.equals(b.outEnv, config.valueLattice) &&
    exprFactsEqual(a.exprFacts, b.exprFacts) &&
    latticeEquals(config.summaryLattice, a.summary, b.summary);
  const envLattice: Lattice<DfaBlockFact<L, S>> = {
    bottom: bottomFact,
    leq: compoundEquals,
    // Commutative monotone join: outEnv merges slot-wise, exprFacts merge
    // per-nodeId, summary merges via its own lattice. Under the DFA's expected
    // monotone transfer, FactStore.write's join(prev, new) collapses to `new`;
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
        summary: config.summaryLattice.join(a.summary, b.summary),
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

  // Structural change: seed entry (forward) / exit (backward); self-wake
  // walks the CFG from there. Evict every previously-written block-key
  // belonging to the rebuilt unit — the prior CFG's `BasicBlock` identities
  // are orphaned after `wireCFG(unit)`, so their facts are stale by key.
  const structuralEdge: EdgeSpec<BasicBlock> = {
    pass: structuralPass,
    wake: (_ctx, key) => {
      const unit = key as FunctionUnit;
      return [config.direction === "forward" ? unit.cfg.entry : unit.cfg.exit];
    },
    evict: (ctx, key) => {
      const unit = key as FunctionUnit;
      const out: BasicBlock[] = [];
      for (const b of ctx.readAll(blockKeyedPass).keys()) {
        if (b.unit === unit) out.push(b);
      }
      return out;
    },
  };

  const edgesArr: EdgeSpec<BasicBlock>[] = [...configEdges, structuralEdge];
  // eslint-disable-next-line prefer-const
  let blockKeyedPass: Pass<BasicBlock, DfaBlockFact<L, S>>;
  // Self-wake: block OUT change → CFG successors recompute IN.
  const selfEdge: EdgeSpec<BasicBlock> = {
    // `pass` is bound below via closure; the worklist reads this at register time.
    get pass() {
      return blockKeyedPass as Pass<any, any>;
    },
    wake: (_ctx, key) => {
      const b = key as BasicBlock;
      return config.direction === "forward" ? b.successors : b.predecessors;
    },
  };
  edgesArr.push(selfEdge);
  // Intentionally not frozen: callers with cross-pass edge cycles (e.g. a
  // block pass that needs to wake on an outer projection pass defined later)
  // amend `edges` post-construction with an additional EdgeSpec.

  blockKeyedPass = {
    id: blockPassId,
    debugName: `${config.debugName}:blocks`,
    lattice: envLattice,
    edges: edgesArr,
    tier: "analysis",
    transfer(ctx: PassCtx, block: BasicBlock): DfaBlockFact<L, S> | undefined {
      const unit = block.unit;
      const inEnv = inEnvFor(ctx, block, unit);
      return config.transferBlock(ctx, block, inEnv, unit);
    },
  };
  return blockKeyedPass;
}

/** Resolve a per-expression fact from the DFA block pass.
 *  `block` must be the BasicBlock that contains `nodeId` in the unit whose
 *  `transferBlock` visited this expression — usually `unit.blockOfNode.get(nodeId)`
 *  where `unit` is the innermost unit containing the node. */
export function readExprFact<L, S = void>(
  factStore: FactStore,
  pass: Pass<BasicBlock, DfaBlockFact<L, S>>,
  block: BasicBlock | undefined,
  nodeId: number,
): L | undefined {
  if (block === undefined) return undefined;
  return factStore.tryRead(pass, block)?.exprFacts.get(nodeId);
}
