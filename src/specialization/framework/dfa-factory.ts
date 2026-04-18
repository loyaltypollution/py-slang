import type { BasicBlock, CFGEdge } from "./cfg";
import type { Context } from "./context";
import type { FactStore } from "./fact-store";
import type { FunctionUnit } from "./function-unit";
import { MutableEnv } from "./mutable-env";
import type { BoundedLattice, EdgeSpec, Lattice, Analysis, AnalysisCtx } from "./analysis";

/** Packages a Kildall block DFA as a `Analysis<BasicBlock, DfaBlockFact<L>>`.
 *  The fact carries the block's OUT env (used for CFG successor propagation)
 *  and the per-node lattice facts the transfer computed inside this block.
 *  Analyses that need block-global sticky state (e.g. purity's "impure" bit)
 *  stash it in `exprFacts` at a sentinel nodeId — exprFacts is joined
 *  per-key via the value lattice, so the sentinel participates in the
 *  usual monotone propagation without a separate summary channel. */

/** Edge projector: map a node-keyed upstream key to its containing block.
 *  Exported so callers of `makeBlockFixpointAnalysis` declare node-fact
 *  upstreams via `addEdge(analysis, {on:"fact", analysis: upstream, wake: nodeIdToBlock})`
 *  rather than a dedicated factory-level `reads` channel. Returns an empty
 *  iterable when the key isn't a number or the node isn't indexed in any
 *  unit's `blockOfNode`. */
export const nodeIdToBlock = (
  ctx: AnalysisCtx,
  key: unknown,
): Iterable<BasicBlock> => {
  if (typeof key !== "number") return [];
  const u = ctx.unitForNode(key);
  const block = u?.blockOfNode.get(key);
  return block === undefined ? [] : [block];
};

/** Output fact for one block under an analysis analysis. */
export interface DfaBlockFact<L> {
  /** Slot-keyed OUT env for forward successor / backward predecessor merging. */
  readonly outEnv: MutableEnv<L>;
  /** NodeId → lattice value for expressions visited in this block's transfer.
   *
   *  Negative nodeIds are reserved as analysis-specific block-global
   *  sentinels. Real AST nodeIds are always non-negative, so a negative key
   *  never collides with a syntactic expression. Sentinels participate in the
   *  factory's per-key lattice join just like regular exprFacts — this lets
   *  an analysis carry sticky block-global state (e.g. an "impure" marker)
   *  without a separate summary channel. Canonical example:
   *  `IMPURE_SENTINEL_NODE_ID` in `purity-analysis/lattice.ts`. */
  readonly exprFacts: ReadonlyMap<number, L>;
}

type DfaDirection = "forward" | "backward";

interface DfaConfigBase<L> {
  readonly debugName: string;
  readonly direction: DfaDirection;
  /** Pure: IN env → OUT env + per-node exprFacts. No fact-store writes. */
  readonly transferBlock: (
    factStore: FactStore,
    ctx: AnalysisCtx,
    block: BasicBlock,
    inEnv: MutableEnv<L>,
    unit: FunctionUnit,
  ) => DfaBlockFact<L>;
  /** Seed the entry (forward) / exit (backward) block's IN env. */
  readonly seedEnv: (unit: FunctionUnit) => MutableEnv<L>;
  /** Per-edge env refinement. See `BlockDfaSpec.refineOnEdge` for the contract.
   *  Mandatory so forgotten implementations surface at compile time; analyses
   *  that don't narrow return `env` unchanged. */
  readonly refineOnEdge: (env: MutableEnv<L>, edge: CFGEdge) => MutableEnv<L>;
}

/** May-merge analyses only need `Lattice<L>` (join + leq). Must-merge needs
 *  `BoundedLattice<L>` so the factory can call `meetWith(..., top)`. The
 *  discriminated union lets `purityBlockAnalysis` (may-merge) supply a plain
 *  `Lattice` without fabricating unused `top`/`meet` — the type system
 *  refuses a must-merge config paired with a non-bounded lattice. */
type DfaConfig<L> = DfaConfigBase<L> & (
  | { readonly mergeKind: "may"; readonly valueLattice: Lattice<L> }
  | { readonly mergeKind: "must"; readonly valueLattice: BoundedLattice<L> }
);

export function makeBlockFixpointAnalysis<L>(
  config: DfaConfig<L>,
): Analysis<BasicBlock, DfaBlockFact<L>> {
  // Frozen singleton: `FactStore.read` returns this for unwritten cells. Any
  // caller that mutates `outEnv` or `exprFacts` in place corrupts every other
  // unwritten read through the same analysis. `Object.freeze` prevents
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

  function inEnvFor(
    factStore: FactStore,
    block: BasicBlock,
    unit: FunctionUnit,
    context: Context,
  ): MutableEnv<L> {
    // Iterate predecessor *edges* so `refineOnEdge` sees the labeled edge
    // (branch-true/false + condition). Backward analyses treat CFG successors
    // as predecessors by symmetry.
    const preds = config.direction === "forward"
      ? block.predecessorEdges
      : block.successorEdges;
    if (preds.length === 0) return config.seedEnv(unit);
    let env: MutableEnv<L> | undefined;
    for (const edge of preds) {
      // `factStore.read` returns the frozen bottomFact for unwritten cells;
      // we never mutate it in place. Read is scoped to `context` so a
      // speculative context's predecessors don't leak ROOT state.
      const predBlock = config.direction === "forward" ? edge.from : edge.to;
      const predOut = factStore.read(blockKeyedAnalysis, predBlock, context).outEnv;
      // Refine across the edge. Identity returns are common and must not
      // allocate; the factory absorbs that by snapshotting only when the
      // refinement returned a truly different env.
      const refined = config.refineOnEdge(predOut, edge);
      if (env === undefined) {
        // If `refined` is the frozen bottomFact env or the pred's shared
        // outEnv, we must snapshot before mutation downstream. If the
        // refinement returned a fresh snapshot already, reuse it.
        env = refined === predOut ? predOut.snapshot() : refined;
      } else {
        if (config.mergeKind === "must") {
          env.meetWith(refined, config.valueLattice);
        } else {
          env.joinWith(refined, config.valueLattice);
        }
      }
    }
    return env ?? config.seedEnv(unit);
  }

  // `edges` is a live array passed to the analysis; construct the analysis first,
  // then push the self-edge referring to `blockKeyedAnalysis` directly. Callers
  // that need node-keyed upstreams add them via `addEdge` after construction
  // using the exported `nodeIdToBlock` projector. The array stays unfrozen
  // to make both self-wake and post-hoc amendments (e.g. purity block ↔
  // scope cycles) safe.
  const edgesArr: EdgeSpec<BasicBlock>[] = [];

  const seedKey = (unit: FunctionUnit): BasicBlock =>
    config.direction === "forward" ? unit.cfg.entry : unit.cfg.exit;

  const blockKeyedAnalysis: Analysis<BasicBlock, DfaBlockFact<L>> = {
    id: blockPassId,
    debugName: `${config.debugName}:blocks`,
    lattice: envLattice,
    edges: edgesArr,
    tier: "analysis",
    transfer(factStore: FactStore, ctx: AnalysisCtx, block: BasicBlock): DfaBlockFact<L> | undefined {
      const unit = block.unit;
      const inEnv = inEnvFor(factStore, block, unit, ctx.currentContext);
      return config.transferBlock(factStore, ctx, block, inEnv, unit);
    },
  };

  const evictStaleBlocks = (factStore: FactStore, _ctx: AnalysisCtx, unit: FunctionUnit): void => {
    for (const b of factStore.readAll(blockKeyedAnalysis).keys()) {
      if (b.unit === unit) factStore.evict(blockKeyedAnalysis, b);
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
  // construction so we can reference `blockKeyedAnalysis` directly, no getter.
  edgesArr.push({
    on: "fact",
    analysis: blockKeyedAnalysis as Analysis<any, any>,
    wake: (_ctx, key) => {
      const b = key as BasicBlock;
      const edges = config.direction === "forward" ? b.successorEdges : b.predecessorEdges;
      // Forward: successor blocks recompute their IN from our OUT.
      // Backward: predecessor blocks recompute from our OUT.
      return edges.map(e => (config.direction === "forward" ? e.to : e.from));
    },
  });

  return blockKeyedAnalysis;
}

/** Resolve a per-expression fact from the DFA block analysis.
 *  `block` must be the BasicBlock that contains `nodeId` in the unit whose
 *  `transferBlock` visited this expression — usually `unit.blockOfNode.get(nodeId)`
 *  where `unit` is the innermost unit containing the node. `context` defaults
 *  to ROOT_CONTEXT; passing a non-ROOT context reads the per-context cell
 *  produced by running the analysis under that speculation's assumptions. */
export function readExprFact<L>(
  factStore: FactStore,
  analysis: Analysis<BasicBlock, DfaBlockFact<L>>,
  block: BasicBlock | undefined,
  nodeId: number,
  context?: Context,
): L | undefined {
  if (block === undefined) return undefined;
  return factStore.tryRead(analysis, block, context)?.exprFacts.get(nodeId);
}
