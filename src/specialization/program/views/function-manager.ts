// Owns Function lifecycle (build/index/rebuild) and the FunctionLocator
// read surface. The generic `ViewManager<V>` interface captures the
// kind-agnostic shell (mint/rebuild + iteration); kind-specific lookups
// (`functionById`, `blockContaining`, ...) live on the locator.
//
// Per-Function speculation policy (futureDispatchContext, refute/spec-rev
// fan-out) is split out into a composed `FunctionDispatchState` —
// orthogonal to "what nodes does this function own", and conflating them
// was the reason `dfa-query` had to duck-type future-dispatch off a
// registry interface.

import { StmtNS } from "../../../ast-types";
import type { FunctionEnvironments } from "../../../resolver";
import { isRoot, ROOT_CONTEXT, type AssumptionChain } from "../../assumption";
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
import type { ViewManager } from "./view-manager";
import { FunctionDispatchState } from "./function-dispatch";

export class FunctionManager implements ViewManager<Function>, FunctionLocator {
  private readonly functionsByFunctionId = new Map<FunctionId, Function>();
  private readonly functionByNode = new Map<NodeId, Function>();
  private readonly nodesByFunction = new Map<Function, Set<NodeId>>();
  private readonly pendingRebuilds = new Set<Function>();

  private readonly mintSubs: Array<(unit: Function) => void> = [];
  private readonly rebuildSubs: Array<(unit: Function) => void> = [];

  /** Speculation-policy state. Public so consumers (Worklist, transforms)
   *  reach speculation concerns through a name that says what it is. */
  readonly dispatch = new FunctionDispatchState();

  constructor(
    ast: StmtNS.FileInput,
    private readonly functionEnvironments: FunctionEnvironments,
  ) {
    for (const [, unit] of buildFunctions(ast, functionEnvironments)) {
      this.registerUnit(unit);
    }
  }

  // ── ViewManager<Function> surface ───────────────────────────────────
  values(): Iterable<Function> {
    return this.functionsByFunctionId.values();
  }

  // ── FunctionLocator surface ─────────────────────────────────────────
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

  // ── Lifecycle subscriptions ─────────────────────────────────────────
  /** Subscribe to mint events. Fires immediately against every existing unit
   *  so late subscribers pick up the initial burst. */
  onMint(cb: (unit: Function) => void): void {
    this.mintSubs.push(cb);
    for (const unit of this.functionsByFunctionId.values()) cb(unit);
  }

  onRebuild(cb: (unit: Function) => void): void { this.rebuildSubs.push(cb); }

  // ── Unit lifecycle ──────────────────────────────────────────────────
  /** Register a structurally-introduced FunctionDef. ROOT-only — function
   *  identity has no chain dimension. */
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

  schedulePendingRebuild(unit: Function): void {
    this.pendingRebuilds.add(unit);
  }

  hasPendingRebuilds(): boolean {
    return this.pendingRebuilds.size > 0;
  }

  /** Rebuild every pending unit's CFG, refresh indices, fire rebuild subs. */
  flushPendingRebuilds(): Function[] {
    if (this.pendingRebuilds.size === 0) return [];
    const rebuilt: Function[] = [];
    for (const unit of this.pendingRebuilds) {
      wireCFG(unit);
      this.reindexUnit(unit);
      rebuilt.push(unit);
    }
    this.pendingRebuilds.clear();
    for (const unit of rebuilt) {
      for (const sub of this.rebuildSubs) sub(unit);
    }
    return rebuilt;
  }

  /** Bridge between the locator (node→function map) and the dispatch
   *  state (function→chain map). Lives on the manager because it joins
   *  two surfaces that the manager already owns and exposes. */
  futureDispatchChainForNode(nodeId: NodeId): AssumptionChain {
    const unit = this.functionContainingNode(nodeId);
    return unit === undefined ? ROOT_CONTEXT : this.dispatch.futureDispatchChainFor(unit);
  }

  // ── Internal indexing ───────────────────────────────────────────────
  private registerUnit(unit: Function): void {
    this.functionsByFunctionId.set(unit.funcAst.id, unit);
    this.indexUnitNodes(unit);
  }

  private reindexUnit(unit: Function): void {
    this.dropUnitNodes(unit);
    this.indexUnitNodes(unit);
  }

  private indexUnitNodes(unit: Function): void {
    const ids = new Set<NodeId>();
    this.nodesByFunction.set(unit, ids);
    for (const id of unit.nodeToBlock.keys()) {
      this.functionByNode.set(id, unit);
      ids.add(id);
    }
  }

  private dropUnitNodes(unit: Function): void {
    const ids = this.nodesByFunction.get(unit);
    if (ids === undefined) return;
    for (const id of ids) this.functionByNode.delete(id);
    this.nodesByFunction.delete(unit);
  }
}
