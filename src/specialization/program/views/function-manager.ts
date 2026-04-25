// Per-Function speculation policy is split into the composed
// `FunctionDispatchState` — orthogonal to node ownership.

import { StmtNS } from "../../../ast-types";
import type { FunctionEnvironments } from "../../../resolver";
import { isRoot, ROOT_CONTEXT, type AssumptionChain } from "../../assumption";
import type { SweepKind } from "../../framework/sweep-kind";
import type { NodeId } from "../node-set";
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

export class FunctionManager implements FunctionLocator, SweepKind<Function> {
  private readonly functionsByFunctionId = new Map<FunctionId, Function>();
  private readonly functionByNode = new Map<NodeId, Function>();
  private readonly pendingRebuilds = new Set<Function>();

  private readonly mintSubs: Array<(unit: Function) => void> = [];
  private readonly rebuildSubs: Array<(unit: Function) => void> = [];

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

  /** Fires immediately against every existing unit so late subscribers
   *  pick up the initial burst. */
  onMint(cb: (unit: Function) => void): void {
    this.mintSubs.push(cb);
    for (const unit of this.functionsByFunctionId.values()) cb(unit);
  }

  onRebuild(cb: (unit: Function) => void): void { this.rebuildSubs.push(cb); }

  /** ROOT-only — function identity has no chain dimension. */
  addFunction(node: StmtNS.FunctionDef, chain: AssumptionChain): Function {
    if (!isRoot(chain)) {
      throw new Error(
        `[FunctionManager.addFunction] structural rewrites are ROOT-only (chain depth=${chain.depth}).`,
      );
    }
    const unit = buildOneFunction(node, this.functionEnvironments);
    this.registerUnit(unit);
    for (const sub of this.mintSubs) sub(unit);
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
    const rebuilt: Function[] = [];
    for (const unit of this.pendingRebuilds) {
      for (const id of unit.nodeToBlock.keys()) this.functionByNode.delete(id);
      wireCFG(unit);
      this.indexUnitNodes(unit);
      rebuilt.push(unit);
    }
    this.pendingRebuilds.clear();
    for (const unit of rebuilt) {
      for (const sub of this.rebuildSubs) sub(unit);
    }
    return rebuilt;
  }

  futureDispatchChainForNode(nodeId: NodeId): AssumptionChain {
    const unit = this.functionContainingNode(nodeId);
    return unit === undefined ? ROOT_CONTEXT : this.dispatch.futureDispatchChainFor(unit);
  }

  private registerUnit(unit: Function): void {
    this.functionsByFunctionId.set(unit.funcAst.id, unit);
    this.indexUnitNodes(unit);
  }

  private indexUnitNodes(unit: Function): void {
    for (const id of unit.nodeToBlock.keys()) this.functionByNode.set(id, unit);
  }
}
