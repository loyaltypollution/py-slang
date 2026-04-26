// FunctionManager — the concrete `FunctionDomain` implementation.
//
// Owns two pieces of state:
//
//   1. **registry / locator** — by-FunctionId, by-NodeId, blockContaining.
//   2. **lifecycle** — `onExtentChange` with subscribe-time mint replay,
//                      `scheduleRebuild` + `flushPendingRebuilds`.
//
// Chain/refute state used to live here too but those are worklist-owned
// policy; the manager was a passive proxy. The `FunctionLocator` interface
// is kept exported because external code takes it as an explicit
// dependency.

import type { StmtNS } from "../../../ast-types";
import type { FunctionEnvironments } from "../../../resolver";
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
  ExtentChangeListener,
  FunctionDomain,
} from "../../framework/function-domain";

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
  extentOf(unit: Function): FunctionExtent {
    return this.snapshotExtent(unit);
  }

  scheduleRebuild(unit: Function): void {
    this.pendingRebuilds.add(unit);
  }

  flushPendingRebuilds(): readonly Function[] {
    if (this.pendingRebuilds.size === 0) return [];
    const rebuilt: { unit: Function; prev: FunctionExtent; next: FunctionExtent }[] = [];
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

  // --- internals ---

  private snapshotExtent(unit: Function): FunctionExtent {
    return nodeSetOfIds(new Set(unit.nodeToBlock.keys())) as FunctionExtent;
  }

  private registerUnit(unit: Function): void {
    this.functionsByFunctionId.set(unit.funcAst.id, unit);
    this.indexUnitNodes(unit);
  }

  private indexUnitNodes(unit: Function): void {
    for (const id of unit.nodeToBlock.keys()) this.functionByNode.set(id, unit);
  }
}
