import type { ExprNS } from "../../ast-types";
import { isRoot, type AssumptionChain } from "../assumption/chain";
import type {
  Analysis,
  AnalysisCtx,
  JoinSemiLattice,
  Lattice,
  NodeId,
  NodeSet,
} from "../framework/analysis";
import { defineAnalysis } from "../framework/analysis";
import type { ReadonlyAnalysisStore } from "../framework/analysis-store";
import { EMPTY_MAP, storeContexts, storeEvict, walkChain } from "../framework/analysis-store";
import type { BasicBlock, BlockLocator, CFGEdge } from "../program/basic-block";
import type { Function } from "../program/function/function";
import type { SlotLookup } from "../program/function/slot-table";
import { EMPTY_NODESET, nodeSetOfIds } from "../program/node-set";
import { MutableEnv } from "./block-env";

export interface BlockDfaSpec<L> extends Lattice<L> {
  readonly mergeKind: "may" | "must";
  readonly direction: "forward" | "backward";

  makeExprVisitor(
    env: MutableEnv<L>,
    unit: Function,
    slotLookup: SlotLookup,
    recordExprFact: (nodeId: NodeId, val: L) => void,
    context: AssumptionChain,
  ): ExprNS.Visitor<L>;

  refineOnEdge?(env: MutableEnv<L>, edge: CFGEdge, unit: Function): MutableEnv<L> | undefined;
}

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

function evictStaleBlockCells(
  store: ReadonlyAnalysisStore<BasicBlock, any>,
  unit: Function,
): void {
  for (const context of storeContexts(store)) {
    for (const b of store.readAll(context).keys()) {
      if (b.unit === unit) storeEvict(store, b, context);
    }
  }
}

export interface BlockFixpointAnalysis<L> {
  readonly env: Analysis<BasicBlock, MutableEnv<L>>;
  readonly facts: Analysis<BasicBlock, ReadonlyMap<number, L>>;
  perExpr(locator: BlockLocator): ReadonlyAnalysisStore<number, L>;
  readPerExprDeepest(
    ctx: AnalysisCtx,
    nodeId: number,
  ): { value: L; witness: AssumptionChain } | undefined;
  seed(view: Function): BasicBlock;
}

export interface BlockPassResult<L> {
  readonly outEnv: MutableEnv<L>;
  readonly exprFacts: ReadonlyMap<number, L>;
}

type DfaConfig<L> = {
  readonly direction: "forward" | "backward";
  readonly transferBlock: (
    ctx: AnalysisCtx,
    block: BasicBlock,
    inEnv: MutableEnv<L>,
    unit: Function,
  ) => BlockPassResult<L>;
  readonly seedEnv: (unit: Function) => MutableEnv<L>;
  readonly refineOnEdge?: (
    env: MutableEnv<L>,
    edge: CFGEdge,
    unit: Function,
  ) => MutableEnv<L> | undefined;
} & (
  | { readonly mergeKind: "may"; readonly valueLattice: JoinSemiLattice<L> }
  | { readonly mergeKind: "must"; readonly valueLattice: Lattice<L> }
);

export function makeBlockFixpointAnalysis<L>(
  config: DfaConfig<L>,
): BlockFixpointAnalysis<L> {
  const bottomEnv = new MutableEnv<L>().freeze();
  const EMPTY_FACTS = EMPTY_MAP as ReadonlyMap<number, L>;
  const valueLattice = config.valueLattice;

  const envLeq = (a: MutableEnv<L>, b: MutableEnv<L>): boolean => a.leq(b, valueLattice);
  const envLattice: JoinSemiLattice<MutableEnv<L>> = {
    bottom: bottomEnv,
    leq: envLeq,
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
    const preds = isForward ? block.predecessorEdges : block.successorEdges;
    if (preds.length === 0) return config.seedEnv(unit);
    let env: MutableEnv<L> | undefined;
    for (const edge of preds) {
      const predBlock = isForward ? edge.from : edge.to;
      const predOut = envAnalysis.store.read(predBlock, context);
      const refined = config.refineOnEdge?.(predOut, edge, unit);
      if (env === undefined) {
        env = refined ?? predOut.snapshot();
      } else if (config.mergeKind === "must") {
        env.meetWith(refined ?? predOut, config.valueLattice);
      } else {
        env.joinWith(refined ?? predOut, config.valueLattice);
      }
    }
    return env ?? config.seedEnv(unit);
  }

  const edgeIter = new EdgeBlockIterable(isForward);
  const downstreamBlocks = (b: BasicBlock): Iterable<BasicBlock> =>
    edgeIter.reset(isForward ? b.successorEdges : b.predecessorEdges);

  const envAnalysis: Analysis<BasicBlock, MutableEnv<L>> = defineAnalysis({
    storeAlgebra: envLattice,
    emptyValue: bottomEnv,
    tier: "analysis",
    polarity: config.mergeKind,
    transfer(ctx, block): MutableEnv<L> | undefined {
      const unit = block.unit;
      const inEnv = inEnvFor(block, unit, ctx.currentContext);
      const result = config.transferBlock(ctx, block, inEnv, unit);

      const prev = factsAnalysis.store.tryRead(block, ctx.currentContext);
      const next = prev === undefined ? result.exprFacts : factsJoin(prev, result.exprFacts);
      const delta = computeFactsDelta(prev, next);
      ctx.write(factsAnalysis, block, next, delta);
      return result.outEnv;
    },
    bind(ctx): void {
      ctx.onExtentChange((unit, isMint) => {
        if (!isMint) evictStaleBlockCells(envAnalysis.store, unit);
        ctx.enqueue(envAnalysis, seedKey(unit));
      });
      ctx.onChainChange(envAnalysis, (_loc, unit) => [seedKey(unit)]);
      ctx.subscribeOnAdvance(envAnalysis, envAnalysis, (_ctx, key) =>
        downstreamBlocks(key as BasicBlock),
      );
    },
  });

  const factsAnalysis: Analysis<BasicBlock, ReadonlyMap<number, L>> = defineAnalysis({
    storeAlgebra: factsLattice,
    emptyValue: EMPTY_FACTS,
    tier: "analysis",
    polarity: config.mergeKind,
    transfer: () => undefined,
    bind(ctx): void {
      ctx.onExtentChange((unit, isMint) => {
        if (!isMint) evictStaleBlockCells(factsAnalysis.store, unit);
      });
    },
  });

  function perExpr(locator: BlockLocator): ReadonlyAnalysisStore<number, L> {
    if (config.mergeKind === "must") {
      throw new Error(
        "perExpr is unsound for must-merge analyses: factsLeq treats missing keys as ⊥, " +
          "which is the wrong polarity for must. No must-analysis currently consumes perExpr.",
      );
    }
    const tryReadNode = (nodeId: number, context: AssumptionChain): L | undefined => {
      const block = locator.blockContaining(nodeId);
      return block === undefined ? undefined : factsAnalysis.store.tryRead(block, context)?.get(nodeId);
    };
    return {
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
  }

  function readPerExprDeepest(
    ctx: AnalysisCtx,
    nodeId: number,
  ): { value: L; witness: AssumptionChain } | undefined {
    if (config.mergeKind === "must") {
      throw new Error(
        "readPerExprDeepest is unsound for must-merge analyses: factsLeq/tryReadNode " +
          "treat missing keys as ⊥, which is the wrong polarity for must.",
      );
    }
    const block = ctx.locator.blockContaining(nodeId);
    if (block === undefined) return undefined;
    ctx.tryRead(factsAnalysis, block);
    let cur: AssumptionChain = ctx.currentContext;
    while (true) {
      const map = factsAnalysis.store.tryRead(block, cur);
      if (map !== undefined) {
        const value = map.get(nodeId);
        if (value !== undefined) return { value, witness: cur };
      }
      if (isRoot(cur)) return undefined;
      cur = cur.parent;
    }
  }

  return {
    env: envAnalysis,
    facts: factsAnalysis,
    perExpr,
    readPerExprDeepest,
    seed: seedKey,
  };
}
