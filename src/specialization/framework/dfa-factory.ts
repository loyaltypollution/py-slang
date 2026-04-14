import type { BasicBlock } from "./cfg";
import type { FactStore } from "./fact-store";
import type { FunctionUnit } from "./function-unit";
import { MutableEnv } from "./mutable-env";
import type { Lattice, Pass, PassCtx } from "./pass";
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

interface DfaConfig<L, S = void> {
  readonly debugName: string;
  readonly direction: DfaDirection;
  readonly top: L;
  readonly leq: (a: L, b: L) => boolean;
  readonly join: (a: L, b: L) => L;
  readonly meet: (a: L, b: L) => L;
  readonly mergeKind: "may" | "must";
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

/** No-op summary lattice for analyses that don't carry block-global state. */
export const VOID_SUMMARY: Lattice<void> = {
  bottom: undefined,
  equals: () => true,
  join: () => undefined,
};

export function makeBlockFixpointPass<L, S = void>(
  config: DfaConfig<L, S>,
): Pass<BasicBlock, DfaBlockFact<L, S>> {
  // Frozen singleton: `FactStore.read` returns this for unwritten cells. Any
  // caller that mutates `outEnv` or `exprFacts` in place corrupts every other
  // unwritten read through the same pass. `Object.freeze` prevents
  // re-assignment of the outer fields; `MutableEnv`'s internal slot array is
  // still mutable (its contract needs it), so callers MUST `snapshot()`
  // before mutation. `inEnvFor` does exactly that; `readExprFact` only reads
  // via `tryRead`/`.get`, which never touches the bottom object.
  const bottomFact: DfaBlockFact<L, S> = Object.freeze({
    outEnv: new MutableEnv<L>(),
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

  const envLattice: Lattice<DfaBlockFact<L, S>> = {
    bottom: bottomFact,
    // All three parts participate in equality: a block whose stmts produce no
    // slot writes (e.g. bare `return e`) has an invariant outEnv, but runtime
    // observations widen per-expression facts inside `e`, and summary-only
    // analyses may flip the block summary without touching slots. Readers of
    // any projection must wake on those.
    //
    // Ripple cost: a change to `exprFacts` or `summary` alone still wakes CFG
    // successors via the self-reader edge on `blockKeyedPass`. Each successor's
    // `transfer` recomputes IN from the same (unchanged) predecessor OUT envs
    // and produces an unchanged OUT, so the ripple dies after one extra hop
    // per successor. Bounded at O(|CFG|) per runtime observation.
    equals: (a, b) =>
      a.outEnv.equals(b.outEnv, config.leq) &&
      exprFactsEqual(a.exprFacts, b.exprFacts) &&
      config.summaryLattice.equals(a.summary, b.summary),
    // Commutative monotone join: outEnv merges slot-wise, exprFacts merge
    // per-nodeId, summary merges via its own lattice. Under the DFA's expected
    // monotone transfer, FactStore.write's join(prev, new) collapses to `new`;
    // commutativity makes that independent of operand order.
    join: (a, b) => {
      const merged = a.outEnv.snapshot();
      if (config.mergeKind === "must") {
        merged.meetWith(b.outEnv, config.meet, config.top);
      } else {
        merged.joinWith(b.outEnv, config.join);
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
  let blockKeyedPass: Pass<BasicBlock, DfaBlockFact<L, S>>;
  blockKeyedPass = {
    id: blockPassId,
    debugName: `${config.debugName}:blocks`,
    lattice: envLattice,
    reads: readsArr,
    tier: "analysis",
    coarse: false,
    transfer(ctx: PassCtx, block: BasicBlock): DfaBlockFact<L, S> | undefined {
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
  // Intentionally not frozen: callers with cross-pass read cycles (e.g. a
  // block pass that needs to wake on an outer projection pass defined later)
  // need to amend `reads` post-construction. Other passes in the codebase
  // hold plain arrays too.

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
