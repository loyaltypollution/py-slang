import type { ExprNS } from "../../ast-types";
import type { AssumptionChain } from "../assumption/chain";
import type {
  Analysis,
  AnalysisCtx,
  JoinSemiLattice,
  Lattice,
  NodeId,
  NodeSet,
} from "../framework/analysis";
import { defineAnalysis } from "../framework/analysis";
import { EMPTY_NODESET, nodeSetOfIds } from "../program/node-set";
import type { FunctionView } from "../program/views/function-view";
import { asProgramCtx } from "../program/program-ctx";
import type { ReadonlyAnalysisStore } from "../framework/analysis-store";
import { EMPTY_MAP, storeContexts, storeEvict, walkChain } from "../framework/analysis-store";
import type { BasicBlock, CFGEdge } from "../program/views/basic-block";
import type { Function } from "../program/views/function";
import { MutableEnv } from "../analysis/mutable-env";
import type { SlotLookup } from "../program/slot-table";

/** Author-facing spec for statement/expression analyses that run over a
 *  function's CFG blocks.
 *
 *  This is a program-layer adapter, not a framework primitive and not a
 *  `View`: callers describe how to transfer statements/expressions and the
 *  factory turns that into the real block-keyed analyses:
 *    - `env:   Analysis<BasicBlock, MutableEnv<L>>`
 *    - `facts: Analysis<BasicBlock, ReadonlyMap<NodeId, L>>`
 *
 *  The spec extends `Lattice<L>` so one object names both the per-slot value
 *  lattice and the expression visitor/refinement behavior. Convenient, but
 *  cognitively dense; keep generic framework concepts out of this type. */
export interface BlockDfaSpec<L> extends Lattice<L> {
  readonly mergeKind: "may" | "must";
  readonly direction: "forward" | "backward";

  /** Per-subtree visitor. Records per-node output facts into
   *  `recordExprFact`; those are written into `.facts` by the factory.
   *
   *  `context` is ROOT_CONTEXT for the unspeculated pass; a non-ROOT
   *  context carries assumption bindings the visitor MAY consult.
   *  AssumptionChain-oblivious modules ignore it. */
  makeExprVisitor(
    env: MutableEnv<L>,
    unit: Function,
    slotLookup: SlotLookup,
    recordExprFact: (nodeId: NodeId, val: L) => void,
    context: AssumptionChain,
  ): ExprNS.Visitor<L>;

  /** Per-edge env refinement, applied before a predecessor's OUT env is
   *  merged into the current block's IN env. Must be monotone (result ⊑
   *  input) and MUST NOT mutate `env` in place — `snapshot()` first. When
   *  omitted, the factory treats every edge as identity (no narrowing). */
  refineOnEdge?(env: MutableEnv<L>, edge: CFGEdge, unit: Function): MutableEnv<L>;
}

/** Self-iterating iterable over block-projected CFG edges. Reused across
 *  self-wake callbacks to avoid per-write allocation. Safe as a singleton
 *  because subscribers consume inline with for-of and never store it. */
class EdgeBlockIterable implements Iterable<BasicBlock>, Iterator<BasicBlock> {
  private edges: readonly CFGEdge[] = [];
  private idx = 0;
  private readonly result: IteratorResult<BasicBlock> = {
    done: false,
    value: undefined as unknown as BasicBlock,
  };
  constructor(private readonly forward: boolean) {}
  reset(edges: readonly CFGEdge[]): this {
    this.edges = edges;
    this.idx = 0;
    return this;
  }
  [Symbol.iterator](): this {
    this.idx = 0;
    return this;
  }
  next(): IteratorResult<BasicBlock> {
    const r = this.result;
    if (this.idx >= this.edges.length) {
      r.done = true;
      r.value = undefined as unknown as BasicBlock;
      return r;
    }
    const e = this.edges[this.idx++];
    r.done = false;
    r.value = this.forward ? e.to : e.from;
    return r;
  }
}

/** Evict every BasicBlock cell belonging to `unit` across all contexts.
 *  Block cells are keyed by `BasicBlock` (not `Function`), so the worklist's
 *  universal unit-keyed eviction doesn't reach them. */
function evictStaleBlockCells(
  store: ReadonlyAnalysisStore<BasicBlock, any>,
  unit: Function,
): void {
  for (const context of storeContexts(store)) {
    for (const b of store.readAll(context).keys()) {
      if (b.unitId === unit.funcAst.id) storeEvict(store, b, context);
    }
  }
}

/** Paired analyses produced by `makeBlockFixpointAnalysis`.
 *
 *    - `.env`   is the CFG fixpoint: block OUT env, successor propagation,
 *               mint/rebuild seeding, and stale-block eviction.
 *    - `.facts` is a block-keyed container for node facts emitted during
 *               `.env` transfer. Its own transfer is a no-op.
 *
 *  The split keeps CFG propagation tied to env changes only: node fact changes
 *  can wake interested consumers via NodeSet deltas without self-waking every
 *  successor block.
 *
 *  `perExpr(view)` is the read facade that projects `nodeId -> owning block ->
 *  block facts`. `seed(unit)` returns the block where the fixpoint starts
 *  (entry for forward, exit for backward). */
export interface BlockFixpointAnalysis<L> {
  readonly env: Analysis<BasicBlock, MutableEnv<L>>;
  readonly facts: Analysis<BasicBlock, ReadonlyMap<number, L>>;
  /** Node-keyed view over `facts`. Canonical read surface for per-expression
   *  consumers. NOT edge-recording — use `readPerExprDeepest(ctx, nodeId)`
   *  from inside a transfer if you want auto-invalidation when the cell
   *  changes. */
  perExpr(view: FunctionView): ReadonlyAnalysisStore<number, L>;
  /** Edge-recording per-expression read. Walks the chain at `ctx.currentContext`,
   *  returning the deepest ancestor whose facts map contains `nodeId`.
   *  Records a read edge on `(facts, blockOfNode(nodeId))` so that any
   *  advancing write to the block's facts map re-enqueues the caller. */
  readPerExprDeepest(
    ctx: AnalysisCtx,
    nodeId: number,
  ): { value: L; witness: AssumptionChain } | undefined;
  seed(view: Function): BasicBlock;
}

/** Result of one block-transfer pass. Negative nodeIds in `exprFacts` are
 *  reserved as analysis-specific block-global sentinels. */
export interface BlockPassResult<L> {
  readonly outEnv: MutableEnv<L>;
  readonly exprFacts: ReadonlyMap<number, L>;
}

/** May-merge analyses only need `JoinSemiLattice<L>`; must-merge needs
 *  `Lattice<L>` so the factory can call `meetWith(..., top)`. */
type DfaConfig<L> = {
  readonly direction: "forward" | "backward";
  /** IN env → OUT env + per-node exprFacts. Called from `.env`'s transfer. */
  readonly transferBlock: (
    ctx: AnalysisCtx,
    block: BasicBlock,
    inEnv: MutableEnv<L>,
    unit: Function,
  ) => BlockPassResult<L>;
  /** Seed the entry (forward) / exit (backward) block's IN env. */
  readonly seedEnv: (unit: Function) => MutableEnv<L>;
  /** Per-edge env refinement. See `BlockDfaSpec.refineOnEdge`. Optional;
   *  omitted means identity (no narrowing on any edge). */
  readonly refineOnEdge?: (env: MutableEnv<L>, edge: CFGEdge, unit: Function) => MutableEnv<L>;
} & (
  | { readonly mergeKind: "may"; readonly valueLattice: JoinSemiLattice<L> }
  | { readonly mergeKind: "must"; readonly valueLattice: Lattice<L> }
);

export function makeBlockFixpointAnalysis<L>(
  config: DfaConfig<L>,
): BlockFixpointAnalysis<L> {
  // Frozen shared bottom: mutators throw, forcing `snapshot()` first.
  const bottomEnv = new MutableEnv<L>().freeze();
  const EMPTY_FACTS = EMPTY_MAP as ReadonlyMap<number, L>;
  const valueLattice = config.valueLattice;

  const envLeq = (a: MutableEnv<L>, b: MutableEnv<L>): boolean => a.leq(b, valueLattice);
  const envLattice: JoinSemiLattice<MutableEnv<L>> = {
    bottom: bottomEnv,
    leq: envLeq,
    // Snapshot `a` before merging — mutating the stored env would corrupt
    // other readers' references.
    join: (a, b) => {
      const merged = a.snapshot();
      if (config.mergeKind === "must") merged.meetWith(b, config.valueLattice);
      else merged.joinWith(b, config.valueLattice);
      return merged;
    },
    eq: (a, b) => a === b || (envLeq(a, b) && envLeq(b, a)),
  };

  const factsJoin = (
    a: ReadonlyMap<number, L>,
    b: ReadonlyMap<number, L>,
  ): ReadonlyMap<number, L> => {
    if (a === b || a.size === 0) return b;
    if (b.size === 0) return a;
    const merged = new Map<number, L>(a);
    for (const [k, vb] of b) {
      const va = merged.get(k);
      merged.set(k, va === undefined ? vb : valueLattice.join(va, vb));
    }
    return merged;
  };

  // Pointwise `a ⊑ b`. Missing keys are ⊥.
  const factsLeq = (
    a: ReadonlyMap<number, L>,
    b: ReadonlyMap<number, L>,
  ): boolean => {
    if (a === b || a.size === 0) return true;
    for (const [k, va] of a) {
      const vb = b.get(k);
      if (vb === undefined || !valueLattice.leq(va, vb)) return false;
    }
    return true;
  };

  /** NodeIds whose post-join value differs from `prev`. `prev`'s exclusive
   *  keys can't change under a `factsJoin` (joins retain prev keys), so they
   *  are not reported. Returns `EMPTY_NODESET` when nothing advanced. */
  const computeFactsDelta = (
    prev: ReadonlyMap<number, L> | undefined,
    next: ReadonlyMap<number, L>,
  ): NodeSet => {
    if (prev === next) return EMPTY_NODESET;
    if (prev === undefined || prev.size === 0) {
      if (next.size === 0) return EMPTY_NODESET;
      return nodeSetOfIds(new Set(next.keys()));
    }
    const changed = new Set<NodeId>();
    for (const [k, vNext] of next) {
      const vPrev = prev.get(k);
      if (vPrev === undefined || !valueLattice.eq(vPrev, vNext)) {
        changed.add(k);
      }
    }
    return changed.size === 0 ? EMPTY_NODESET : nodeSetOfIds(changed);
  };

  const factsLattice: JoinSemiLattice<ReadonlyMap<number, L>> = {
    bottom: EMPTY_FACTS,
    leq: factsLeq,
    join: factsJoin,
    eq: (a, b) => a === b || (factsLeq(a, b) && factsLeq(b, a)),
  };

  const seedKey = (unit: Function): BasicBlock =>
    config.direction === "forward" ? unit.cfg.entry : unit.cfg.exit;

  const isForward = config.direction === "forward";

  function inEnvFor(
    block: BasicBlock,
    unit: Function,
    context: AssumptionChain,
  ): MutableEnv<L> {
    // Iterate predecessor *edges* so `refineOnEdge` sees the labeled edge.
    // Backward analyses treat CFG successors as predecessors by symmetry.
    const preds = isForward ? block.predecessorEdges : block.successorEdges;
    if (preds.length === 0) return config.seedEnv(unit);
    let env: MutableEnv<L> | undefined;
    for (const edge of preds) {
      const predBlock = isForward ? edge.from : edge.to;
      const predOut = envAnalysis.store.read(predBlock, context);
      const refined = config.refineOnEdge ? config.refineOnEdge(predOut, edge, unit) : predOut;
      if (env === undefined) {
        // Snapshot only when `refineOnEdge` returned the stored env unchanged.
        env = refined === predOut ? predOut.snapshot() : refined;
      } else if (config.mergeKind === "must") {
        env.meetWith(refined, config.valueLattice);
      } else {
        env.joinWith(refined, config.valueLattice);
      }
    }
    return env ?? config.seedEnv(unit);
  }

  const envAnalysis: Analysis<BasicBlock, MutableEnv<L>> = defineAnalysis({
    storeAlgebra: envLattice,
    emptyValue: bottomEnv,
    tier: "analysis",
    polarity: config.mergeKind,
    transfer(ctx, block): MutableEnv<L> | undefined {
      const unit = asProgramCtx(ctx).functions.get(block.unitId);
      if (unit === undefined) return undefined;
      const inEnv = inEnvFor(block, unit, ctx.currentContext);
      const result = config.transferBlock(ctx, block, inEnv, unit);
      // Paired-cell write: `.facts` has no transfer of its own, so its
      // cell is populated exclusively from here. Route through `ctx.write`
      // (not the store directly) so the eq-gated advance publishes a
      // FactChange to every `factsAnalysis` subscriber.
      //
      // Compute a delta NodeSet covering nodeIds whose value advanced
      // relative to the prior cell at this context. Pre-joining here
      // mirrors what `storeWrite` will do internally (idempotent), letting
      // us classify per-key changes against the post-join value rather than
      // the caller's intent. nodeSet subscribers (e.g. purity scoping on
      // `IMPURE_SENTINEL_NODE_ID`) consume this delta to suppress wakes
      // when their interest doesn't intersect the change.
      const prev = factsAnalysis.store.tryRead(block, ctx.currentContext);
      const next = prev === undefined ? result.exprFacts : factsJoin(prev, result.exprFacts);
      const delta = computeFactsDelta(prev, next);
      ctx.write(factsAnalysis, block, next, delta);
      return result.outEnv;
    },
  });

  const factsAnalysis: Analysis<BasicBlock, ReadonlyMap<number, L>> = defineAnalysis({
    storeAlgebra: factsLattice,
    emptyValue: EMPTY_FACTS,
    tier: "analysis",
    polarity: config.mergeKind,
    // Populated as a side effect of envAnalysis.transfer; returning
    // undefined means "no write from this path".
    transfer: () => undefined,
  });

  // envAnalysis: lifecycle seeds + evictions + CFG-successor self-wake.
  // Pooled edge-iterable avoids allocating per advancing `.env` write.
  const edgeIter = new EdgeBlockIterable(isForward);
  const downstreamBlocks = (b: BasicBlock): Iterable<BasicBlock> =>
    edgeIter.reset(isForward ? b.successorEdges : b.predecessorEdges);
  envAnalysis.bind = (wl) => {
    wl.onMint(envAnalysis, (_ctx, unit) => [seedKey(unit)]);
    wl.onRebuildDirty(envAnalysis, (_ctx, unit) => [seedKey(unit)]);
    wl.onRebuildEvict((unit) => evictStaleBlockCells(envAnalysis.store, unit));
    // Spec-context revision invalidates the block fixpoint under the old
    // context; re-seed the entry/exit block so the new context's fixpoint
    // starts from the seed env rather than stale successor envs. Intrinsic
    // to context-sensitive block-DFA; every makeBlockFixpointAnalysis caller
    // needs it, so the factory owns it.
    wl.onSpecRev(envAnalysis, (_ctx, unit) => [seedKey(unit)]);
    // Self-wake: block OUT env change → CFG successors recompute IN.
    wl.subscribeOnAdvance(envAnalysis, envAnalysis, (_ctx, key) =>
      downstreamBlocks(key as BasicBlock),
    );
  };

  // factsAnalysis: eviction only. envAnalysis drives the seed; expr facts
  // do not propagate through CFG successors.
  factsAnalysis.bind = (wl) => {
    wl.onRebuildEvict((unit) => evictStaleBlockCells(factsAnalysis.store, unit));
  };

  const perExprCache = new WeakMap<FunctionView, ReadonlyAnalysisStore<number, L>>();
  function perExpr(view: FunctionView): ReadonlyAnalysisStore<number, L> {
    const cached = perExprCache.get(view);
    if (cached !== undefined) return cached;
    const tryReadNode = (nodeId: number, context: AssumptionChain): L | undefined => {
      const block = view.functionOfNode(nodeId)?.blockOfNode(nodeId);
      return block === undefined ? undefined : factsAnalysis.store.tryRead(block, context)?.get(nodeId);
    };
    const store: ReadonlyAnalysisStore<number, L> = {
      read(nodeId, context) {
        return tryReadNode(nodeId, context) ?? valueLattice.bottom;
      },
      tryRead: tryReadNode,
      readAll(context) {
        const flat = new Map<number, L>();
        for (const blockMap of factsAnalysis.store.readAll(context).values()) {
          for (const [nodeId, value] of blockMap) flat.set(nodeId, value);
        }
        return flat;
      },
      readMinimal(chain, key, accept) {
        return walkChain(chain, key, tryReadNode, "minimal", accept);
      },
      readDeepest(chain, key) {
        return walkChain(chain, key, tryReadNode, "deepest");
      },
    };
    perExprCache.set(view, store);
    return store;
  }

  function readPerExprDeepest(
    ctx: AnalysisCtx,
    nodeId: number,
  ): { value: L; witness: AssumptionChain } | undefined {
    const block = asProgramCtx(ctx).functionOfNode(nodeId)?.blockOfNode(nodeId);
    if (block === undefined) return undefined;
    // Single edge on (factsAnalysis, block) — invalidation fires on any
    // advancing write to that block's facts map. Walk via store.tryRead so
    // we get a per-context view; the edge dedup means we record once.
    ctx.tryRead(factsAnalysis, block);
    let cur: AssumptionChain | undefined = ctx.currentContext;
    while (cur !== undefined) {
      const map = factsAnalysis.store.tryRead(block, cur);
      if (map !== undefined) {
        const value = map.get(nodeId);
        if (value !== undefined) return { value, witness: cur };
      }
      cur = cur.parent;
    }
    return undefined;
  }

  return {
    env: envAnalysis,
    facts: factsAnalysis,
    perExpr,
    readPerExprDeepest,
    seed: seedKey,
  };
}
