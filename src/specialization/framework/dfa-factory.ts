import type { BasicBlock, CFGEdge } from "./cfg";
import type { Context } from "./context";
import type { Unit } from "./function-unit";
import { MutableEnv } from "./mutable-env";
import type {
  Lattice,
  EdgeSpec,
  JoinSemiLattice,
  Analysis,
  AnalysisCtx,
  SemanticAnalysis,
} from "./analysis";
import { defineAnalysis } from "./analysis";
import { storeContexts, storeEvict } from "./analysis-store";
import type { ProgramTopology } from "./topology";

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

/** Edge projector: map a node-keyed upstream key to its containing block.
 *  Exported so callers of `makeBlockFixpointAnalysis` declare node-fact
 *  upstreams via `addEdge(bfa.env, {on:"fact", analysis: upstream, wake: nodeIdToBlock})`
 *  rather than a dedicated factory-level `reads` channel. Returns an empty
 *  iterable when the key isn't a number or the node isn't indexed in the
 *  program topology. */
export const nodeIdToBlock = (
  ctx: AnalysisCtx,
  key: unknown,
): Iterable<BasicBlock> => {
  if (typeof key !== "number") return [];
  const block = ctx.topology.blockOfNode(key);
  return block === undefined ? [] : [block];
};

/** Paired block-DFA analyses produced by `makeBlockFixpointAnalysis`.
 *
 *  `env` drives the fixpoint. `facts` is a side-written cell read by
 *  per-node consumers (transforms via `readExprFact`, sentinel-reading
 *  outer analyses). `seed(unit)` returns the block at which the fixpoint
 *  is seeded for `unit`: entry for forward, exit for backward. */
export interface BlockFixpointAnalysis<L> {
  readonly env: SemanticAnalysis<BasicBlock, MutableEnv<L>>;
  readonly facts: SemanticAnalysis<BasicBlock, ReadonlyMap<number, L>>;
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
  readonly debugName: string;
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

  // `edges` arrays stay unfrozen so callers with mutually-recursive edges
  // (e.g. purity block ↔ scope) can append via `addEdge` after construction.
  const envEdges: EdgeSpec<BasicBlock>[] = [];
  const factsEdges: EdgeSpec<BasicBlock>[] = [];

  const seedKey = (unit: Unit): BasicBlock =>
    config.direction === "forward" ? unit.cfg.entry : unit.cfg.exit;

  function inEnvFor(
    block: BasicBlock,
    unit: Unit,
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
    id: Symbol(`${config.debugName}:env`),
    debugName: `${config.debugName}:env`,
    keySpace: "BasicBlock",
    storeAlgebra: envLattice,
    emptyValue: bottomEnv,
    edges: envEdges,
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
    id: Symbol(`${config.debugName}:facts`),
    debugName: `${config.debugName}:facts`,
    keySpace: "BasicBlock",
    storeAlgebra: factsLattice,
    emptyValue: EMPTY_FACTS,
    edges: factsEdges,
    tier: "analysis",
    polarity: config.mergeKind,
    // Facts cell is populated as a side effect of envAnalysis.transfer;
    // returning undefined means "no write from this transfer path." The
    // worklist only ever enqueues this analysis if something explicitly
    // calls `enqueue(factsAnalysis, ...)`, which nothing does today.
    transfer: () => undefined,
  });

  const evictStaleEnvCells = (_ctx: AnalysisCtx, unit: Unit): void => {
    for (const context of storeContexts(envAnalysis.store)) {
      for (const b of envAnalysis.store.readAll(context).keys()) {
        if (b.unit === unit) storeEvict(envAnalysis.store, b, context);
      }
    }
  };

  const evictStaleFactsCells = (_ctx: AnalysisCtx, unit: Unit): void => {
    for (const context of storeContexts(factsAnalysis.store)) {
      for (const b of factsAnalysis.store.readAll(context).keys()) {
        if (b.unit === unit) storeEvict(factsAnalysis.store, b, context);
      }
    }
  };

  // envAnalysis: lifecycle seeds and evictions, plus CFG-successor self-wake.
  // Block cells are keyed by `BasicBlock` (not `Unit`), so the worklist's
  // universal unit-keyed eviction doesn't reach them; we do it here.
  envEdges.push(
    { on: "mint", wake: (_ctx, unit) => [seedKey(unit)] },
    {
      on: "rebuild",
      wake: (_ctx, unit) => [seedKey(unit)],
      effect: evictStaleEnvCells,
    },
    { on: "retire", effect: evictStaleEnvCells },
  );

  // Self-wake: block OUT env change → CFG successors recompute IN. Appended
  // after construction so we can reference `envAnalysis` directly, no getter.
  envEdges.push({
    on: "fact",
    analysis: envAnalysis as Analysis<any, any>,
    wake: (_ctx, key) => {
      const b = key as BasicBlock;
      const edges = config.direction === "forward" ? b.successorEdges : b.predecessorEdges;
      return edges.map(e => (config.direction === "forward" ? e.to : e.from));
    },
  });

  // factsAnalysis: eviction only. No mint seed (envAnalysis drives the seed
  // and paired-writes produce facts as a side effect); no self-wake (expr
  // facts do not propagate through CFG successors — the old compound analysis
  // conflated the two cases and produced spurious ripples per observation,
  // now eliminated by the split).
  factsEdges.push(
    { on: "rebuild", effect: evictStaleFactsCells },
    { on: "retire", effect: evictStaleFactsCells },
  );

  return {
    env: envAnalysis,
    facts: factsAnalysis,
    seed: seedKey,
  };
}

/** Resolve a per-expression fact from a paired block-DFA analysis.
 *
 *  The topology bridge — node → block — is centralized here so callers
 *  never recompute `unit.blockOfNode.get(nodeId)` or similar. `context` is
 *  mandatory: `Context` is the primitive, ROOT is one tree-root position
 *  inside it, and a per-node fact read has no default position. Transform
 *  code does not call this directly — it reads through
 *  `TransformFactView.readExprFact`, which binds ROOT once at view
 *  construction.
 *
 *  Returns `undefined` if the node is unknown to `topology` (e.g. freshly
 *  minted outside any indexed unit) or if the block's facts cell has no
 *  fact for that node yet. */
export function readExprFact<L>(
  topology: ProgramTopology,
  analysis: BlockFixpointAnalysis<L>,
  nodeId: number,
  context: Context,
): L | undefined {
  const block = topology.blockOfNode(nodeId);
  if (block === undefined) return undefined;
  return analysis.facts.store.tryRead(block, context)?.get(nodeId);
}
