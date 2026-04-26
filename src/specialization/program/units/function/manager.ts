// Per-Function speculation policy is split into the composed
// `FunctionDispatchState` — orthogonal to node ownership.

import type { StmtNS } from "../../../../ast-types";
import type { FunctionEnvironments } from "../../../../resolver";
import type { AssumptionChain } from "../../../assumption";
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
import type { FunctionLocator } from "./locator";
import type { BasicBlock } from "../../regions/basic-block";
import { FunctionDispatchState } from "./dispatch";
import type {
  ChainChangeListener,
  ExtentChangeListener,
  RefuteListener,
  UnitDomain,
} from "../../../framework/unit-domain";

export type ExtentListener = ExtentChangeListener<Function>;

export class FunctionManager implements FunctionLocator, UnitDomain<Function, FunctionLocator> {
  private readonly functionsByFunctionId = new Map<FunctionId, Function>();
  private readonly functionByNode = new Map<NodeId, Function>();
  private readonly pendingRebuilds = new Set<Function>();

  private readonly extentSubs: ExtentListener[] = [];

  private readonly dispatch = new FunctionDispatchState();

  constructor(ast: StmtNS.FileInput, functionEnvironments: FunctionEnvironments) {
    for (const [, unit] of buildFunctions(ast, functionEnvironments)) {
      this.registerUnit(unit);
    }
  }

  values(): Iterable<Function> {
    return this.functionsByFunctionId.values();
  }

  /** `UnitDomain.locator` — `FunctionManager` is its own locator. */
  get locator(): FunctionLocator { return this; }

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

  scheduleRebuild(unit: Function): void {
    this.pendingRebuilds.add(unit);
  }

  chainFor(unit: Function): AssumptionChain {
    return this.dispatch.futureDispatchChainFor(unit);
  }

  /** `UnitDomain` chain stream — facade over the composed dispatch state. */
  onChainChange(cb: ChainChangeListener<Function>): void {
    this.dispatch.onChainChange(cb);
  }

  setChainFor(unit: Function, chain: AssumptionChain): void {
    this.dispatch.setFutureDispatchContext(unit, chain);
  }

  clearChainFor(unit: Function): void {
    this.dispatch.clearFutureDispatchContext(unit);
  }

  fireChainChange(unit: Function, prev: AssumptionChain, next: AssumptionChain): void {
    this.dispatch.fireChainChange(unit, prev, next);
  }

  /** `UnitDomain` refute stream — facade over the composed dispatch state. */
  onRefute(cb: RefuteListener<Function>): void {
    this.dispatch.onRefute(cb);
  }

  /** Fire refute subscribers only. The worklist owns the
   *  reconcile-against-Refutations decision. */
  fireRefute(unit: Function, carrier: AssumptionChain): void {
    this.dispatch.fireRefute(unit, carrier);
  }

  /** `UnitDomain.extentOf(unit)` — public snapshot of `unit`'s current
   *  CFG-owned ids. Same shape as the `next` payload on the extent stream. */
  extentOf(unit: Function): UnitExtent {
    return this.snapshotExtent(unit);
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
