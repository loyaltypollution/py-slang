// Per-Function speculation policy is split into the composed
// `FunctionDispatchState` — orthogonal to node ownership.

import { StmtNS } from "../../ast-types";
import type { FunctionEnvironments } from "../../resolver";
import { isRoot, ROOT_CONTEXT, type AssumptionChain } from "../assumption";
import { EMPTY_NODESET, nodeSetOfIds, type NodeId, type NodeSet } from "./node-set";
import {
  buildFunctions,
  buildOneFunction,
  wireCFG,
  type Function,
  type FunctionId,
} from "./function";
import type { FunctionLocator } from "./function-locator";
import type { BasicBlock } from "./basic-block";
import { FunctionDispatchState } from "./function-dispatch";

export type ExtentListener = (unit: Function, prev: NodeSet, next: NodeSet) => void;

export class FunctionManager implements FunctionLocator {
  private readonly functionsByFunctionId = new Map<FunctionId, Function>();
  private readonly functionByNode = new Map<NodeId, Function>();
  private readonly pendingRebuilds = new Set<Function>();

  private readonly extentSubs: ExtentListener[] = [];

  readonly dispatch = new FunctionDispatchState();

  constructor(
    ast: StmtNS.FileInput,
    private readonly functionEnvironments: FunctionEnvironments,
  ) {
    for (const [, unit] of buildFunctions(ast, functionEnvironments)) {
      this.registerUnit(unit);
    }
  }

  values(): Iterable<Function> {
    return this.functionsByFunctionId.values();
  }

  functionById(id: FunctionId): Function | undefined {
    return this.functionsByFunctionId.get(id);
  }

  functionForAst(ast: StmtNS.FileInput | StmtNS.FunctionDef): Function | undefined {
    return this.functionsByFunctionId.get(ast.id);
  }

  functionContainingNode(nodeId: NodeId): Function | undefined {
    return this.functionByNode.get(nodeId);
  }

  blockContaining(nodeId: NodeId): BasicBlock | undefined {
    return this.functionByNode.get(nodeId)?.blockOfNode(nodeId);
  }

  /** Sole lifecycle primitive. Fires for every existing unit at subscribe
   *  time with `prev = EMPTY_NODESET` so late subscribers replay the mint
   *  burst. Subsequent fires:
   *    - addFunction:  (unit, EMPTY_NODESET, snapshot)
   *    - flushPendingRebuilds: (unit, prevSnapshot, nextSnapshot)
   *  Eviction listeners gate on `prev.size > 0`. */
  onExtentChange(cb: ExtentListener): void {
    this.extentSubs.push(cb);
    for (const unit of this.functionsByFunctionId.values()) {
      cb(unit, EMPTY_NODESET, this.snapshotExtent(unit));
    }
  }

  /** ROOT-only — function identity has no chain dimension. */
  addFunction(node: StmtNS.FunctionDef, chain: AssumptionChain): Function {
    if (!isRoot(chain)) {
      throw new Error(
        `[FunctionManager.addFunction] structural rewrites are ROOT-only (chain depth=${chain.depth}).`,
      );
    }
    const unit = buildOneFunction(node, this.functionEnvironments);
    this.registerUnit(unit);
    const next = this.snapshotExtent(unit);
    for (const sub of this.extentSubs) sub(unit, EMPTY_NODESET, next);
    return unit;
  }

  scheduleRebuild(unit: Function): void {
    this.pendingRebuilds.add(unit);
  }

  chainFor(unit: Function): AssumptionChain {
    return this.dispatch.futureDispatchChainFor(unit);
  }

  hasPendingRebuilds(): boolean {
    return this.pendingRebuilds.size > 0;
  }

  flushPendingRebuilds(): Function[] {
    if (this.pendingRebuilds.size === 0) return [];
    const rebuilt: { unit: Function; prev: NodeSet; next: NodeSet }[] = [];
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

  futureDispatchChainForNode(nodeId: NodeId): AssumptionChain {
    const unit = this.functionContainingNode(nodeId);
    return unit === undefined ? ROOT_CONTEXT : this.dispatch.futureDispatchChainFor(unit);
  }

  private snapshotExtent(unit: Function): NodeSet {
    return nodeSetOfIds(new Set(unit.nodeToBlock.keys()));
  }

  private registerUnit(unit: Function): void {
    this.functionsByFunctionId.set(unit.funcAst.id, unit);
    this.indexUnitNodes(unit);
  }

  private indexUnitNodes(unit: Function): void {
    for (const id of unit.nodeToBlock.keys()) this.functionByNode.set(id, unit);
  }
}
