// FunctionManager — the concrete `FunctionDomain` implementation.
//
// Owns three orthogonal pieces of state, all kept private:
//
//   1. **registry / locator** — by-FunctionId, by-NodeId, blockContaining.
//   2. **lifecycle** — `onExtentChange` with subscribe-time mint replay,
//                      `scheduleRebuild` + `flushPendingRebuilds`.
//   3. **chain** — `futureDispatchContextByUnit` plus the chain-change
//                  and refute fan-out streams.
//
// The split previously lived across `manager.ts` + `locator.ts` +
// `dispatch.ts`. Each side was small (~20–60 lines) and had no consumer
// beyond this class, so they're inlined here. The `FunctionLocator`
// interface is kept exported because external code takes it as an
// explicit dependency.

import type { StmtNS } from "../../../../ast-types";
import type { FunctionEnvironments } from "../../../../resolver";
import { ROOT_CONTEXT, type AssumptionChain } from "../../../assumption";
import {
  EMPTY_NODESET,
  nodeSetOfIds,
  type NodeId,
} from "../../node-set";
import type { UnitExtent } from "../../unit-extent";
import {
  buildFunctions,
  wireCFG,
  type Function,
  type FunctionId,
} from "./function";
import type { BasicBlock, BlockLocator } from "../../regions/basic-block";
import type {
  ChainChangeListener,
  ExtentChangeListener,
  FunctionDomain,
  RefuteListener,
} from "../../../framework/unit-domain";

/** Read-only program-wide lookup surface for `Function`. Owned by
 *  `FunctionManager`. Consumers that need program-shape lookup take this
 *  as an explicit dependency rather than casting `AnalysisCtx` to a
 *  richer ctx.
 *
 *  Composes `BlockLocator` (one method block-keyed analyses need),
 *  `unitContainingNode` (the worklist's only required locator query),
 *  and `functionById` for callers that resolve a unit by its
 *  FunctionId boundary key. */
export interface FunctionLocator extends BlockLocator {
  /** The worklist's only required locator query — observation ingress
   *  uses this to route NodeId-keyed events to their owning function. */
  unitContainingNode(nodeId: NodeId): Function | undefined;
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
  /** Per-unit preferred chain for future compiles/dispatches. Unset or
   *  ROOT_CONTEXT means future dispatch is unspecialized. */
  private readonly futureDispatchContextByUnit = new Map<Function, AssumptionChain>();
  private readonly chainSubs: ChainChangeListener[] = [];
  private readonly refuteSubs: RefuteListener[] = [];

  constructor(ast: StmtNS.FileInput, functionEnvironments: FunctionEnvironments) {
    for (const [, unit] of buildFunctions(ast, functionEnvironments)) {
      this.registerUnit(unit);
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
  unitContainingNode(nodeId: NodeId): Function | undefined {
    return this.functionByNode.get(nodeId);
  }

  /** `BlockLocator` — block-keyed analyses' only required query. */
  blockContaining(nodeId: NodeId): BasicBlock | undefined {
    return this.functionByNode.get(nodeId)?.blockOfNode(nodeId);
  }

  // --- lifecycle (extent stream + rebuild) ---

  /** Sole lifecycle primitive. Fires for every existing unit at subscribe
   *  time with `prev = EMPTY_NODESET` so late subscribers replay the mint
   *  burst. Rebuild fires `(unit, prevSnapshot, nextSnapshot)`.
   *  Eviction listeners gate on `prev.size > 0`. */
  onExtentChange(cb: ExtentChangeListener): void {
    this.extentSubs.push(cb);
    for (const unit of this.functionsByFunctionId.values()) {
      cb(unit, EMPTY_NODESET, this.snapshotExtent(unit));
    }
  }

  /** `FunctionDomain.extentOf(unit)` — public snapshot of `unit`'s current
   *  CFG-owned ids. Same shape as the `next` payload on the extent stream. */
  extentOf(unit: Function): UnitExtent {
    return this.snapshotExtent(unit);
  }

  scheduleRebuild(unit: Function): void {
    this.pendingRebuilds.add(unit);
  }

  flushPendingRebuilds(): readonly Function[] {
    if (this.pendingRebuilds.size === 0) return [];
    const rebuilt: { unit: Function; prev: UnitExtent; next: UnitExtent }[] = [];
    for (const unit of this.pendingRebuilds) {
      const prev = this.snapshotExtent(unit);
      for (const id of unit.nodeToBlock.keys()) this.functionByNode.delete(id);
      wireCFG(unit);
      this.indexUnitNodes(unit);
      rebuilt.push({ unit, prev, next: this.snapshotExtent(unit) });
    }
    this.pendingRebuilds.clear();
    for (const { unit, prev, next } of rebuilt) {
      for (const sub of this.extentSubs) sub(unit, prev, next);
    }
    return rebuilt.map(r => r.unit);
  }

  // --- chain (preferred future-dispatch) ---

  chainFor(unit: Function): AssumptionChain {
    return this.futureDispatchContextByUnit.get(unit) ?? ROOT_CONTEXT;
  }

  setChainFor(unit: Function, chain: AssumptionChain): void {
    this.futureDispatchContextByUnit.set(unit, chain);
  }

  clearChainFor(unit: Function): void {
    this.futureDispatchContextByUnit.delete(unit);
  }

  onChainChange(cb: ChainChangeListener): void {
    this.chainSubs.push(cb);
  }

  fireChainChange(unit: Function, prev: AssumptionChain, next: AssumptionChain): void {
    for (const sub of this.chainSubs) sub(unit, prev, next);
  }

  // --- refute (orthogonal to chain change) ---

  onRefute(cb: RefuteListener): void {
    this.refuteSubs.push(cb);
  }

  /** Fire refute subscribers for `(unit, carrier)`. Does not touch
   *  futureDispatchContext — the worklist owns the reconcile decision
   *  (clear-if-refuted) so the framework keeps fire and reconcile
   *  separable. */
  fireRefute(unit: Function, carrier: AssumptionChain): void {
    for (const sub of this.refuteSubs) sub(unit, carrier);
  }

  // --- internals ---

  private snapshotExtent(unit: Function): UnitExtent {
    return nodeSetOfIds(new Set(unit.nodeToBlock.keys())) as UnitExtent;
  }

  private registerUnit(unit: Function): void {
    this.functionsByFunctionId.set(unit.funcAst.id, unit);
    this.indexUnitNodes(unit);
  }

  private indexUnitNodes(unit: Function): void {
    for (const id of unit.nodeToBlock.keys()) this.functionByNode.set(id, unit);
  }
}
