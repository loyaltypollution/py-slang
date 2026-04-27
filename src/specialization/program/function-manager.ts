// Function registry + lifecycle. Owns the function-id → Function index,
// the node→function inverse, pending CFG rebuilds, and mint/rebuild
// subscriber lists. Worklist holds an instance and delegates Function-shape
// orchestration here.
//
// Speculation/refute state (per-unit futureDispatchContext, spec-rev subs,
// refute subs) lives on Worklist directly — it's policy that the registry
// has no business knowing about.

import { StmtNS } from "../../ast-types";
import type { FunctionEnvironments } from "../../resolver";
import { isRoot, type AssumptionChain } from "../assumption";
import type { NodeId } from "./node-set";
import type { FunctionId } from "./function-keys";
import { buildFunctions, buildOneFunction, wireCFG, type Function } from "./function";
import type { FunctionRegistry } from "./function-keys";

/** Owns Function lifecycle and indexing. Implements `FunctionRegistry` so it's
 *  the runtime backing for `ProgramCtx.functions` / `ProgramCtx.functionOfNode`. */
export class FunctionManager implements FunctionRegistry {
  private readonly functionsByFunctionId = new Map<FunctionId, Function>();
  private readonly functionByNode = new Map<NodeId, Function>();
  private readonly nodesByFunction = new Map<Function, Set<NodeId>>();
  private readonly pendingRebuilds = new Set<Function>();

  private readonly mintSubs: Array<(unit: Function) => void> = [];
  private readonly rebuildSubs: Array<(unit: Function) => void> = [];

  constructor(
    ast: StmtNS.FileInput,
    private readonly functionEnvironments: FunctionEnvironments,
  ) {
    for (const [, unit] of buildFunctions(ast, functionEnvironments)) {
      this.registerUnit(unit);
    }
  }

  // ── FunctionRegistry surface ────────────────────────────────────────
  get functions(): ReadonlyMap<FunctionId, Function> {
    return this.functionsByFunctionId;
  }

  functionOfNode(nodeId: NodeId): Function | undefined {
    return this.functionByNode.get(nodeId);
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

  /** Mark a unit for CFG rebuild after a transform fire. Worklist drains
   *  these via `flushPendingRebuilds`. */
  schedulePendingRebuild(unit: Function): void {
    this.pendingRebuilds.add(unit);
  }

  hasPendingRebuilds(): boolean {
    return this.pendingRebuilds.size > 0;
  }

  /** Rebuild every pending unit's CFG, refresh indices, fire rebuild subs.
   *  Returns the rebuilt units in iteration order. */
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
