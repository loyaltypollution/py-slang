// Single mutable source of truth for program topology.
//
// Every node/block/unit/function lookup the framework needs funnels through
// the readonly `ProgramTopology` projection. The `MutableProgramTopology`
// implementation is the one writer — owned by the worklist, updated only
// on unit lifecycle transitions (mint, rebuild, retire). Analyses,
// transforms, DfaQuery, and narrowings read, never write.
//
// Before this module existed the same indices were scattered: per-unit
// `blockOfNode` populated inside `wireCFG`, cross-unit `nodeToUnit`
// rebuilt by the worklist, `unitsByFunctionId` also on the worklist, plus
// ad-hoc `unit.blockOfNode.get(...)` lookups at every transform/query
// site. Consolidating them here is what the "topology bridges" refactor
// was about: one ownership boundary, one rebuild path, one surface.
//
// Units are identified by `FunctionId` — the `.id` of the scope-owning
// AST node (`FileInput` or `FunctionDef`). The `funcAst` union on `Unit`
// is an internal AST-shape concern; the topology surface speaks only in
// `FunctionId` and doesn't leak the AST shape. Lambdas are registered in
// the `FunctionRegistry` but do not yet own units; when they do, the
// widening will happen inside `function-unit.ts` without touching this
// surface.

import type { BasicBlock } from "./cfg";
import type { Unit } from "./function-unit";
import type { FunctionId, NodeId } from "./key-spaces";

interface NodeLocation {
  readonly unit: Unit;
  readonly block: BasicBlock;
}

/** Readonly projection of the program's cross-unit index state.
 *  Consumed by `AnalysisCtx`, `DfaQuery`, transforms, and narrowings. */
export interface ProgramTopology {
  /** Every indexed unit, keyed by the `FunctionId` of its scope AST node
   *  (`.id` of the FunctionDef or FileInput). Iterate via `.values()`;
   *  look up by function id via `.get(id)`. */
  readonly units: ReadonlyMap<FunctionId, Unit>;
  unitOfFunctionId(functionId: FunctionId): Unit | undefined;
  unitOfNode(nodeId: NodeId): Unit | undefined;
  blockOfNode(nodeId: NodeId): BasicBlock | undefined;
  /** NodeIds currently indexed under `unit`. Used by retirement eviction
   *  paths that need to walk a unit's fact cells without re-traversing the
   *  AST. Iteration order is insertion (indexing walk) order. */
  nodesOfUnit(unit: Unit): Iterable<NodeId>;
}

/** Owning implementation. The worklist constructs exactly one and exposes
 *  the readonly view via `Worklist.topology`. */
export class MutableProgramTopology implements ProgramTopology {
  private readonly unitsByFunctionId = new Map<FunctionId, Unit>();
  private readonly nodeLocation = new Map<NodeId, NodeLocation>();
  private readonly nodesByUnit = new Map<Unit, Set<NodeId>>();

  /** Register a newly-built unit. `unit.cfg` must already be populated
   *  (via `wireCFG`) so the node-indexing walk sees real blocks. */
  registerUnit(unit: Unit): void {
    this.unitsByFunctionId.set(unit.funcAst.id, unit);
    this.indexUnitNodes(unit);
  }

  /** Drop all index entries for a retiring unit. */
  unregisterUnit(unit: Unit): void {
    this.unitsByFunctionId.delete(unit.funcAst.id);
    this.dropUnitNodes(unit);
  }

  /** Called after `wireCFG` rebuilds a unit's CFG (structural transform).
   *  The unit identity is preserved; only block identities and the
   *  node→block mapping change. */
  reindexUnit(unit: Unit): void {
    this.dropUnitNodes(unit);
    this.indexUnitNodes(unit);
  }

  get units(): ReadonlyMap<FunctionId, Unit> {
    return this.unitsByFunctionId;
  }
  unitOfFunctionId(functionId: FunctionId): Unit | undefined {
    return this.unitsByFunctionId.get(functionId);
  }
  unitOfNode(nodeId: NodeId): Unit | undefined {
    return this.nodeLocation.get(nodeId)?.unit;
  }
  blockOfNode(nodeId: NodeId): BasicBlock | undefined {
    return this.nodeLocation.get(nodeId)?.block;
  }
  nodesOfUnit(unit: Unit): Iterable<NodeId> {
    return this.nodesByUnit.get(unit) ?? EMPTY_IDS;
  }

  private indexUnitNodes(unit: Unit): void {
    const ids = new Set<NodeId>();
    this.nodesByUnit.set(unit, ids);
    for (const block of unit.cfg.blocks) {
      for (const stmt of block.stmts) {
        walkAstNodes(stmt, unit, block, this.nodeLocation, ids);
      }
    }
  }

  private dropUnitNodes(unit: Unit): void {
    const ids = this.nodesByUnit.get(unit);
    if (ids === undefined) return;
    for (const id of ids) this.nodeLocation.delete(id);
    this.nodesByUnit.delete(unit);
  }
}

const EMPTY_IDS: ReadonlySet<NodeId> = new Set();

function walkAstNodes(
  node: unknown,
  unit: Unit,
  block: BasicBlock,
  out: Map<NodeId, NodeLocation>,
  ids: Set<NodeId>,
  seen: WeakSet<object> = new WeakSet(),
): void {
  if (node === null || typeof node !== "object") return;
  if (seen.has(node as object)) return;
  seen.add(node as object);
  const obj = node as Record<string, unknown>;
  const id = obj.id;
  if (typeof id === "number") {
    out.set(id, { unit, block });
    ids.add(id);
  }
  for (const key of Object.keys(obj)) {
    const child = obj[key];
    if (Array.isArray(child)) {
      for (const item of child) walkAstNodes(item, unit, block, out, ids, seen);
    } else if (typeof child === "object" && child !== null) {
      walkAstNodes(child, unit, block, out, ids, seen);
    }
  }
}
