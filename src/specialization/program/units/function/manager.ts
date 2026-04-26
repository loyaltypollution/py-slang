// FunctionManager — `UnitDomain<Function, FunctionLocator>` for the
// only concrete unit kind today.
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
import type { BasicBlock } from "../../regions/basic-block";
import type {
  ChainChangeListener,
  ExtentChangeListener,
  RefuteListener,
  UnitDomain,
  UnitLocator,
} from "../../../framework/unit-domain";

/** Read-only program-wide lookup surface for `Function`. Owned by
 *  `FunctionManager`. Consumers that need program-shape lookup take this
 *  as an explicit dependency rather than casting `AnalysisCtx` to a
 *  richer ctx.
 *
 *  Extends `UnitLocator<Function>` (the minimum surface generic worklist
 *  code needs) with function-specific queries used by analyses,
 *  transforms, and observation ingress. */
export interface FunctionLocator extends UnitLocator<Function> {
  /** Lookup by FunctionId boundary key (typically `funcAst.id`). */
  functionById(id: FunctionId): Function | undefined;
  /** Resolve the BasicBlock that owns `nodeId`, or undefined if `nodeId`
   *  is not part of any indexed function. */
  blockContaining(nodeId: NodeId): BasicBlock | undefined;
}

export type ExtentListener = ExtentChangeListener<Function>;

export class FunctionManager implements FunctionLocator, UnitDomain<Function, FunctionLocator> {
  // --- registry / locator state ---
  private readonly functionsByFunctionId = new Map<FunctionId, Function>();
  private readonly functionByNode = new Map<NodeId, Function>();

  // --- lifecycle state ---
  private readonly pendingRebuilds = new Set<Function>();
  private readonly extentSubs: ExtentListener[] = [];

  // --- chain / refute state ---
  /** Per-unit preferred chain for future compiles/dispatches. Unset or
   *  ROOT_CONTEXT means future dispatch is unspecialized. */
  private readonly futureDispatchContextByUnit = new Map<Function, AssumptionChain>();
  private readonly chainSubs: ChainChangeListener<Function>[] = [];
  private readonly refuteSubs: RefuteListener<Function>[] = [];

  constructor(ast: StmtNS.FileInput, functionEnvironments: FunctionEnvironments) {
    for (const [, unit] of buildFunctions(ast, functionEnvironments)) {
      this.registerUnit(unit);
    }
  }

  // --- locator surface ---

  /** `UnitDomain.locator` — `FunctionManager` is its own locator. */
  get locator(): FunctionLocator { return this; }

  values(): Iterable<Function> {
    return this.functionsByFunctionId.values();
  }

  functionById(id: FunctionId): Function | undefined {
    return this.functionsByFunctionId.get(id);
  }

  /** `UnitLocator<Function>` — the generic worklist's only required
   *  locator query. */
  unitContainingNode(nodeId: NodeId): Function | undefined {
    return this.functionByNode.get(nodeId);
  }

  blockContaining(nodeId: NodeId): BasicBlock | undefined {
    return this.functionByNode.get(nodeId)?.blockOfNode(nodeId);
  }

  // --- lifecycle (extent stream + rebuild) ---

  /** Sole lifecycle primitive. Fires for every existing unit at subscribe
   *  time with `prev = EMPTY_NODESET` so late subscribers replay the mint
   *  burst. Rebuild fires `(unit, prevSnapshot, nextSnapshot)`.
   *  Eviction listeners gate on `prev.size > 0`. */
  onExtentChange(cb: ExtentListener): void {
    this.extentSubs.push(cb);
    for (const unit of this.functionsByFunctionId.values()) {
      cb(unit, EMPTY_NODESET, this.snapshotExtent(unit));
    }
  }

  /** `UnitDomain.extentOf(unit)` — public snapshot of `unit`'s current
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

  onChainChange(cb: ChainChangeListener<Function>): void {
    this.chainSubs.push(cb);
  }

  fireChainChange(unit: Function, prev: AssumptionChain, next: AssumptionChain): void {
    for (const sub of this.chainSubs) sub(unit, prev, next);
  }

  // --- refute (orthogonal to chain change) ---

  onRefute(cb: RefuteListener<Function>): void {
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
