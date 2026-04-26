// FunctionManager — the concrete `FunctionDomain` implementation.
//
// Owns three orthogonal pieces of state, all kept private:
//
//   1. **registry / locator** — by-FunctionId, by-NodeId, blockContaining.
//   2. **lifecycle** — `onExtentChange` with subscribe-time mint replay,
//                      `scheduleRebuild` + `flushPendingRebuilds`.
//   3. **chain** — `futureDispatchContextByFunction` plus the chain-change
//                  and refute fan-out streams.
//
// The split previously lived across `manager.ts` + `locator.ts` +
// `dispatch.ts`. Each side was small (~20–60 lines) and had no consumer
// beyond this class, so they're inlined here. The `FunctionLocator`
// interface is kept exported because external code takes it as an
// explicit dependency.

import type { StmtNS } from "../../../ast-types";
import type { FunctionEnvironments } from "../../../resolver";
import { ROOT_CONTEXT, type AssumptionChain } from "../../assumption";
import {
  EMPTY_NODESET,
  nodeSetOfIds,
  type NodeId,
} from "../node-set";
import type { FunctionExtent } from "../function-extent";
import {
  buildFunctions,
  wireCFG,
  type Function,
  type FunctionId,
} from "./function";
import type { BasicBlock, BlockLocator } from "../basic-block";
import type {
  ChainChangeListener,
  ExtentChangeListener,
  FunctionDomain,
  RefuteListener,
} from "../../framework/function-domain";

/** Read-only program-wide lookup surface for `Function`. Owned by
 *  `FunctionManager`. Consumers that need program-shape lookup take this
 *  as an explicit dependency rather than casting `AnalysisCtx` to a
 *  richer ctx.
 *
 *  Composes `BlockLocator` (one method block-keyed analyses need),
 *  `functionContainingNode` (the worklist's only required locator query),
 *  and `functionById` for callers that resolve a function by its
 *  FunctionId boundary key. */
export interface FunctionLocator extends BlockLocator {
  /** The worklist's only required locator query — observation ingress
   *  uses this to route NodeId-keyed events to their owning function. */
  functionContainingNode(nodeId: NodeId): Function | undefined;
  /** Lookup by FunctionId boundary key (typically `funcAst.id`). */
  functionById(id: FunctionId): Function | undefined;
}

export class FunctionManager implements FunctionLocator, FunctionDomain {
  // --- registry / locator state ---
  private readonly functionsByFunctionId = new Map<FunctionId, Function>();
  private readonly functionByNode = new Map<NodeId, Function>();

  // --- lifecycle state ---
  private readonly pendingRebuilds = new Set<Function>();
  private readonly extentSubs: ExtentChangeListener[] = [];

  // --- chain / refute state ---
  /** Per-function preferred chain for future compiles/dispatches. Unset or
   *  ROOT_CONTEXT means future dispatch is unspecialized. */
  private readonly futureDispatchContextByFunction = new Map<Function, AssumptionChain>();
  private readonly chainSubs: ChainChangeListener[] = [];
  private readonly refuteSubs: RefuteListener[] = [];

  constructor(ast: StmtNS.FileInput, functionEnvironments: FunctionEnvironments) {
    for (const [, function] of buildFunctions(ast, functionEnvironments)) {
      this.registerFunction(function);
    }
  }

  // --- locator surface ---

  /** `FunctionDomain.locator` — `FunctionManager` is its own locator. */
  get locator(): FunctionLocator { return this; }

  values(): Iterable<Function> {
    return this.functionsByFunctionId.values();
  }

  functionById(id: FunctionId): Function | undefined {
    return this.functionsByFunctionId.get(id);
  }

  /** The worklist's only required locator query — used by observation
   *  ingress to route NodeId-keyed events to their owning function. */
  functionContainingNode(nodeId: NodeId): Function | undefined {
    return this.functionByNode.get(nodeId);
  }

  /** `BlockLocator` — block-keyed analyses' only required query. */
  blockContaining(nodeId: NodeId): BasicBlock | undefined {
    return this.functionByNode.get(nodeId)?.blockOfNode(nodeId);
  }

  // --- lifecycle (extent stream + rebuild) ---

  /** Sole lifecycle primitive. Fires for every existing function at subscribe
   *  time with `prev = EMPTY_NODESET` so late subscribers replay the mint
   *  burst. Rebuild fires `(function, prevSnapshot, nextSnapshot)`.
   *  Eviction listeners gate on `prev.size > 0`. */
  onExtentChange(cb: ExtentChangeListener): void {
    this.extentSubs.push(cb);
    for (const function of this.functionsByFunctionId.values()) {
      cb(function, EMPTY_NODESET, this.snapshotExtent(function));
    }
  }

  /** `FunctionDomain.extentOf(function)` — public snapshot of `function`'s current
   *  CFG-owned ids. Same shape as the `next` payload on the extent stream. */
  extentOf(function: Function): FunctionExtent {
    return this.snapshotExtent(function);
  }

  scheduleRebuild(function: Function): void {
    this.pendingRebuilds.add(function);
  }

  flushPendingRebuilds(): readonly Function[] {
    if (this.pendingRebuilds.size === 0) return [];
    const rebuilt: { function: Function; prev: FunctionExtent; next: FunctionExtent }[] = [];
    for (const function of this.pendingRebuilds) {
      const prev = this.snapshotExtent(function);
      for (const id of function.nodeToBlock.keys()) this.functionByNode.delete(id);
      wireCFG(function);
      this.indexFunctionNodes(function);
      rebuilt.push({ function, prev, next: this.snapshotExtent(function) });
    }
    this.pendingRebuilds.clear();
    for (const { function, prev, next } of rebuilt) {
      for (const sub of this.extentSubs) sub(function, prev, next);
    }
    return rebuilt.map(r => r.function);
  }

  // --- chain (preferred future-dispatch) ---

  chainFor(function: Function): AssumptionChain {
    return this.futureDispatchContextByFunction.get(function) ?? ROOT_CONTEXT;
  }

  setChainFor(function: Function, chain: AssumptionChain): void {
    this.futureDispatchContextByFunction.set(function, chain);
  }

  clearChainFor(function: Function): void {
    this.futureDispatchContextByFunction.delete(function);
  }

  onChainChange(cb: ChainChangeListener): void {
    this.chainSubs.push(cb);
  }

  fireChainChange(function: Function, prev: AssumptionChain, next: AssumptionChain): void {
    for (const sub of this.chainSubs) sub(function, prev, next);
  }

  // --- refute (orthogonal to chain change) ---

  onRefute(cb: RefuteListener): void {
    this.refuteSubs.push(cb);
  }

  /** Fire refute subscribers for `(function, carrier)`. Does not touch
   *  futureDispatchContext — the worklist owns the reconcile decision
   *  (clear-if-refuted) so the framework keeps fire and reconcile
   *  separable. */
  fireRefute(function: Function, carrier: AssumptionChain): void {
    for (const sub of this.refuteSubs) sub(function, carrier);
  }

  // --- internals ---

  private snapshotExtent(function: Function): FunctionExtent {
    return nodeSetOfIds(new Set(function.nodeToBlock.keys())) as FunctionExtent;
  }

  private registerFunction(function: Function): void {
    this.functionsByFunctionId.set(function.funcAst.id, function);
    this.indexFunctionNodes(function);
  }

  private indexFunctionNodes(function: Function): void {
    for (const id of function.nodeToBlock.keys()) this.functionByNode.set(id, function);
  }
}
