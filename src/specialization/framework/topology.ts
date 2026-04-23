// Single mutable source of truth for program topology. Every
// node/block/unit/function lookup funnels through `ProgramTopology`. The
// worklist owns the one instance and is the only writer.
// Units are identified by `FunctionId` — the `.id` of the scope-owning
// AST node (`FileInput` or `FunctionDef`).

import type { BasicBlock } from "./cfg";
import type { Unit } from "./function-unit";
import type { FunctionId, NodeId } from "./key-spaces";

interface NodeLocation {
  readonly unit: Unit;
  readonly block: BasicBlock;
}

export class ProgramTopology {
  private readonly unitsByFunctionId = new Map<FunctionId, Unit>();
  private readonly nodeLocation = new Map<NodeId, NodeLocation>();
  private readonly nodesByUnit = new Map<Unit, Set<NodeId>>();

  /** Register a newly-built unit. `unit.cfg` must already be populated. */
  registerUnit(unit: Unit): void {
    this.unitsByFunctionId.set(unit.funcAst.id, unit);
    this.indexUnitNodes(unit);
  }

  /** Called after `wireCFG` rebuilds a unit's CFG. Unit identity is
   *  preserved; block and node→block mappings change. */
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

/** Read-only projection handed to analyses, DfaQuery, transforms, and
 *  narrowings. */
export type ReadonlyProgramTopology = Pick<
  ProgramTopology,
  "units" | "unitOfFunctionId" | "unitOfNode" | "blockOfNode"
>;

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
