import type { ExprNS } from "../../ast-types";
import type { BasicBlock, CFGEdge } from "./cfg";
import type { Speculation } from "./assumption-chain";
import type { Unit } from "./function-unit";
import type { NodeId } from "./key-spaces";
import type { SlotLookup } from "./slot-table";
import { MutableEnv } from "./mutable-env";
import type {
  Lattice,
  JoinSemiLattice,
  Analysis,
  AnalysisCtx,
  SemanticAnalysis,
} from "./analysis";
import { defineAnalysis } from "./analysis";
import type { ReadonlyAnalysisStore } from "./analysis-store";
import {
  storeContexts,
  storeEvict,
  walkChainDeepest,
  walkChainMinimal,
} from "./analysis-store";
import type { ProgramTopology, ReadonlyProgramTopology } from "./topology";

/** Expression-level DFA module for block-fixpoint analyses. Extends
 *  `Lattice<L>` so the module itself IS the per-slot value lattice —
 *  no separate field, no duplication between `BlockDfaSpec` and the
 *  `valueLattice` passed to `makeBlockFixpointAnalysis`. */
export interface BlockDfaSpec<L> extends Lattice<L> {
  readonly mergeKind: "may" | "must";
  readonly direction: "forward" | "backward";

  /** Per-subtree visitor. Records per-node output facts into
   *  `recordExprFact`; those flow out via `recordExprFact` and are written
   *  into the block analysis's `.facts` cell by the factory's paired-cell
   *  write. Visitors that need cross-analysis reads do so directly via
   *  `otherAnalysis.store.read(key, context)` — the store is read-only on
   *  the public surface, so no accidental write path is introduced.
   *
   *  `context` is the speculation context this transfer is running under.
   *  ROOT_CONTEXT for the unspeculated pass; a non-ROOT context carries
   *  assumption bindings the visitor MAY consult (via `findAssumption`) to
   *  narrow per-node facts. Modules that are speculation-oblivious ignore
   *  the parameter. */
  makeExprVisitor(
    env: MutableEnv<L>,
    unit: Unit,
    slotLookup: SlotLookup,
    recordExprFact: (nodeId: NodeId, val: L) => void,
    context: Speculation,
  ): ExprNS.Visitor<L>;

  /** Per-edge env refinement. Called by the DFA factory before a predecessor
   *  block's OUT env is merged into the current block's IN env. Must be
   *  monotone: the returned env is ⊑ the input.
   *
   *  Contract: MUST NOT mutate `env` in place. To refine, `env.snapshot()`
   *  first, mutate the snapshot, and return it. To opt out of refinement,
   *  return `env` unchanged — the factory detects identity and elides a
   *  redundant snapshot. */
  refineOnEdge(env: MutableEnv<L>, edge: CFGEdge): MutableEnv<L>;
}

/** Self-iterating iterable over block-projected CFG edges. Reused across
 *  every self-wake callback (one instance per DFA analysis) to eliminate the
 *  `.map(e => e.to)` array that used to allocate per advancing `.env` write.
 *
 *  Safe as a singleton because `onFactDirty`'s subscriber iterates the
 *  returned iterable inline with for-of and never stores it; `reset()` before
 *  each iteration sets `.idx` back to 0. The IteratorResult object is also
 *  reused — for-of only reads `done`/`value` before the next `.next()`. */
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
 *  Block cells are keyed by `BasicBlock` (not `Unit`), so the worklist's
 *  universal unit-keyed eviction doesn't reach them. */
function evictStaleBlockCells(
  store: ReadonlyAnalysisStore<BasicBlock, any>,
  unit: Unit,
): void {
  for (const context of storeContexts(store)) {
    for (const b of store.readAll(context).keys()) {
      if (b.unit === unit) storeEvict(store, b, context);
    }
  }
}

/** Packages a Kildall block DFA as a PAIR of `Analysis` objects over the
 *  same BasicBlock keyspace:
 *
 *    - `.env`   stores the block's OUT env (slot-lifted semantic domain).
 *               Owns the fixpoint: CFG-successor propagation, seed on
 *               mint/rebuild, eviction on rebuild/retire.
 *    - `.facts` stores per-node expression facts and analysis-specific
 *               sticky sentinel keys (e.g. purity's `IMPURE_SENTINEL_NODE_ID`).
 *               Populated as a side effect of `.env`'s transfer — its own
 *               transfer is a no-op. Consumers read per-node facts via
 *               `readExprFact`; sentinel-reading outer analyses subscribe
 *               via `{on:"fact", analysis: bfa.facts}`.
 *
 *  Splitting the old single-cell `DfaBlockFact<L>` into two paired cells
 *  removes the spurious-ripple problem of the compound store algebra: an
 *  `exprFacts`-only change (e.g. an observation narrowing a sub-expression)
 *  used to wake every CFG successor even though no successor's OUT env
 *  could shift. With the split, successor wake fires only on `.env` changes;
 *  per-node-fact consumers wake only on `.facts` changes. */

/** Paired block-DFA analyses produced by `makeBlockFixpointAnalysis`.
 *
 *  `env` drives the fixpoint. `facts` is a side-written cell carrying a
 *  per-block `ReadonlyMap<nodeId, L>` — block-keyed access is load-bearing
 *  for sentinel readers (e.g. purity's `IMPURE_SENTINEL_NODE_ID`). The
 *  typical per-expression consumer uses `perExpr(topology)` instead: a
 *  node-keyed `ReadonlyAnalysisStore<nodeId, L>` adapter suitable for
 *  `analysis.readMinimal` / `analysis.readDeepest` / `analysis.tryRead`.
 *
 *  `seed(unit)` returns the block at which the fixpoint is seeded for
 *  `unit`: entry for forward, exit for backward. */
export interface BlockFixpointAnalysis<L> {
  readonly env: SemanticAnalysis<BasicBlock, MutableEnv<L>>;
  readonly facts: SemanticAnalysis<BasicBlock, ReadonlyMap<number, L>>;
  /** Node-keyed view over `facts`. Reads resolve `topology.blockOfNode(nodeId)`
   *  then look up `nodeId` inside the block's map. `tryRead` returns
   *  `undefined` when the node is unknown or unwritten; `read` returns
   *  `valueLattice.bottom` in those cases. `readAll` flattens every block's
   *  fact map under `context` into one `nodeId → L` map. This is the
   *  canonical node-keyed read surface for per-expression consumers. */
  perExpr(topology: ReadonlyProgramTopology): ReadonlyAnalysisStore<number, L>;
  seed(unit: Unit): BasicBlock;
}

/** Result of one block-transfer pass: the updated OUT env plus per-node
 *  expr facts. Stored into `.env` and `.facts` respectively. Negative
 *  nodeIds in `exprFacts` are reserved as analysis-specific block-global
 *  sentinels (see `IMPURE_SENTINEL_NODE_ID` in purity). */
export interface BlockPassResult<L> {
  readonly outEnv: MutableEnv<L>;
  readonly exprFacts: ReadonlyMap<number, L>;
}

type DfaDirection = "forward" | "backward";

interface DfaConfigBase<L> {
  readonly direction: DfaDirection;
  /** IN env → OUT env + per-node exprFacts. Called from `.env`'s transfer;
   *  the factory performs both cell writes (`.env` via return value,
   *  `.facts` via the factory's paired-cell side effect). */
  readonly transferBlock: (
    ctx: AnalysisCtx,
    block: BasicBlock,
    inEnv: MutableEnv<L>,
    unit: Unit,
  ) => BlockPassResult<L>;
  /** Seed the entry (forward) / exit (backward) block's IN env. */
  readonly seedEnv: (unit: Unit) => MutableEnv<L>;
  /** Per-edge env refinement. See `BlockDfaSpec.refineOnEdge` for the contract.
   *  Mandatory so forgotten implementations surface at compile time; analyses
   *  that don't narrow return `env` unchanged. */
  readonly refineOnEdge: (env: MutableEnv<L>, edge: CFGEdge) => MutableEnv<L>;
}

/** May-merge analyses only need `JoinSemiLattice<L>` (join + leq). Must-merge needs
 *  `Lattice<L>` so the factory can call `meetWith(..., top)`. The
 *  discriminated union lets `purityBlockAnalysis` (may-merge) supply a plain
 *  `Lattice` without fabricating unused `top`/`meet` — the type system
 *  refuses a must-merge config paired with a non-bounded lattice. */
type DfaConfig<L> = DfaConfigBase<L> & (
  | { readonly mergeKind: "may"; readonly valueLattice: JoinSemiLattice<L> }
  | { readonly mergeKind: "must"; readonly valueLattice: Lattice<L> }
);

export function makeBlockFixpointAnalysis<L>(
  config: DfaConfig<L>,
): BlockFixpointAnalysis<L> {
  // Frozen shared bottoms. `bottomEnv.freeze()` makes the slot-array mutators
  // throw — `inEnvFor` must `snapshot()` before any mutation. Forgotten
  // snapshots used to silently corrupt every unwritten read through the
  // shared bottom; now they throw at the first offending write.
  const bottomEnv = new MutableEnv<L>().freeze();
  // EMPTY_FACTS is defended only by its `ReadonlyMap` type annotation — there
  // is no runtime freeze, because `Object.freeze` does not block
  // `Map.prototype.set`. Callers must not cast away the readonly and mutate;
  // doing so would corrupt every unwritten `.facts` cell that defaults to
  // this shared instance. All current readers either call `.get(nodeId)` or
  // route writes through `ctx.write`, which allocates a new Map via
  // `factsLattice.join` rather than mutating in place.
  const EMPTY_FACTS: ReadonlyMap<number, L> = new Map();

  const envLattice: JoinSemiLattice<MutableEnv<L>> = {
    bottom: bottomEnv,
    leq: (a, b) => a.leq(b, config.valueLattice),
    // Mutating `a` would corrupt the stored env other readers hold a
    // reference to; snapshot first. Commutative monotone combine on the
    // slot-lifted domain: under the DFA's monotone transfer, this collapses
    // to `b` when `a ⊑ b`, matching the store's join(prev, new) fast path.
    join: (a, b) => {
      const merged = a.snapshot();
      if (config.mergeKind === "must") {
        merged.meetWith(b, config.valueLattice);
      } else {
        merged.joinWith(b, config.valueLattice);
      }
      return merged;
    },
    eq: (a, b) => a === b
      || (a.leq(b, config.valueLattice) && b.leq(a, config.valueLattice)),
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
      merged.set(k, va === undefined ? vb : config.valueLattice.join(va, vb));
    }
    return merged;
  };

  // Pointwise `a ⊑ b`. Missing keys are ⊥; the `a.size === 0` shortcut
  // handles the common case where a freshly-built fact is compared against
  // an established one.
  const factsLeq = (
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

  const factsLattice: JoinSemiLattice<ReadonlyMap<number, L>> = {
    bottom: EMPTY_FACTS,
    leq: factsLeq,
    join: factsJoin,
    eq: (a, b) => a === b || (factsLeq(a, b) && factsLeq(b, a)),
  };

  const seedKey = (unit: Unit): BasicBlock =>
    config.direction === "forward" ? unit.cfg.entry : unit.cfg.exit;

  function inEnvFor(
    block: BasicBlock,
    unit: Unit,
    context: Speculation,
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
      // `envAnalysis.store.read` returns `bottomEnv` (frozen) for unwritten
      // cells; we never mutate it in place. Read is scoped to `context` so
      // a speculative context's predecessors don't leak ROOT state.
      const predBlock = config.direction === "forward" ? edge.from : edge.to;
      const predOut = envAnalysis.store.read(predBlock, context);
      // Refine across the edge. Identity returns are common and must not
      // allocate; the factory absorbs that by snapshotting only when the
      // refinement returned a truly different env.
      const refined = config.refineOnEdge(predOut, edge);
      if (env === undefined) {
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

  const envAnalysis: SemanticAnalysis<BasicBlock, MutableEnv<L>> = defineAnalysis({
    storeAlgebra: envLattice,
    emptyValue: bottomEnv,
    tier: "analysis",
    polarity: config.mergeKind,
    transfer(ctx, block): MutableEnv<L> | undefined {
      const unit = block.unit;
      const inEnv = inEnvFor(block, unit, ctx.currentContext);
      const result = config.transferBlock(ctx, block, inEnv, unit);
      // Paired-cell write. `.facts` has no transfer of its own — its cell is
      // populated exclusively from here so the two cells always advance
      // together under a single block pass. Route through `ctx.write` (not a
      // direct store write) so the eq-gated advance publishes a
      // FactChange to every subscriber of `factsAnalysis` — analyses like
      // purityScopeAnalysis that wake on `.facts` writes would otherwise
      // never see the update.
      ctx.write(factsAnalysis, block, result.exprFacts);
      return result.outEnv;
    },
  });

  const factsAnalysis: SemanticAnalysis<BasicBlock, ReadonlyMap<number, L>> = defineAnalysis({
    storeAlgebra: factsLattice,
    emptyValue: EMPTY_FACTS,
    tier: "analysis",
    polarity: config.mergeKind,
    // Facts cell is populated as a side effect of envAnalysis.transfer;
    // returning undefined means "no write from this transfer path." The
    // worklist only ever enqueues this analysis if something explicitly
    // calls `enqueue(factsAnalysis, ...)`, which nothing does today.
    transfer: () => undefined,
  });

  // envAnalysis: lifecycle seeds and evictions, plus CFG-successor self-wake.
  // Pooled iterable reused on every self-wake callback: `onFactDirty` fires on
  // every advancing `.env` write — allocating a fresh `.map(e => e.to)` array
  // per fire is the dominant per-write allocation under fixpoint convergence.
  // One iterable per analysis, reset on each call. For-of on `Iterable` reads
  // `Symbol.iterator` once per outer call and never stores the iterator after
  // the loop, so a single self-iterating object is safe.
  const isForward = config.direction === "forward";
  const edgeIter = new EdgeBlockIterable(isForward);
  const downstreamBlocks = (b: BasicBlock): Iterable<BasicBlock> =>
    edgeIter.reset(isForward ? b.successorEdges : b.predecessorEdges);
  envAnalysis.bind = (wl) => {
    wl.onMint(envAnalysis, (_ctx, unit) => [seedKey(unit)]);
    wl.onRebuildDirty(envAnalysis, (_ctx, unit) => [seedKey(unit)]);
    wl.onRebuildEvict((_h, unit) => evictStaleBlockCells(envAnalysis.store, unit));
    // Self-wake: block OUT env change → CFG successors recompute IN.
    wl.onFactDirty(envAnalysis as Analysis<any, any>, envAnalysis, (_ctx, key) =>
      downstreamBlocks(key as BasicBlock),
    );
  };

  // factsAnalysis: eviction only. No mint seed (envAnalysis drives the seed
  // and paired-writes produce facts as a side effect); no self-wake (expr
  // facts do not propagate through CFG successors — the old compound analysis
  // conflated the two cases and produced spurious ripples per observation,
  // now eliminated by the split).
  factsAnalysis.bind = (wl) => {
    wl.onRebuildEvict((_h, unit) => evictStaleBlockCells(factsAnalysis.store, unit));
  };

  const perExprCache = new WeakMap<ReadonlyProgramTopology, ReadonlyAnalysisStore<number, L>>();
  function perExpr(topology: ReadonlyProgramTopology): ReadonlyAnalysisStore<number, L> {
    const cached = perExprCache.get(topology);
    if (cached !== undefined) return cached;
    const tryReadNode = (nodeId: number, context: Speculation): L | undefined => {
      const block = topology.blockOfNode(nodeId);
      if (block === undefined) return undefined;
      return factsAnalysis.store.tryRead(block, context)?.get(nodeId);
    };
    const store: ReadonlyAnalysisStore<number, L> = {
      read(nodeId, context) {
        return tryReadNode(nodeId, context) ?? config.valueLattice.bottom;
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
        return walkChainMinimal(chain, key, tryReadNode, accept);
      },
      readDeepest(chain, key) {
        return walkChainDeepest(chain, key, tryReadNode);
      },
    };
    perExprCache.set(topology, store);
    return store;
  }

  return {
    env: envAnalysis,
    facts: factsAnalysis,
    perExpr,
    seed: seedKey,
  };
}
