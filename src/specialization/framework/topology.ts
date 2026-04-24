// Program-wide lookups keyed by `NodeId`/`FunctionId`. The worklist owns
// the one instance and is the only writer. Block-level node indexing lives
// on `Unit` (see `Unit.blockOfNode`); this class only tracks which unit
// owns which node.

import type { Unit } from "./function-unit";
import type { FunctionId, NodeId } from "./analysis";

export class ProgramTopology {
  private readonly unitsByFunctionId = new Map<FunctionId, Unit>();
  private readonly unitByNode = new Map<NodeId, Unit>();
  private readonly nodesByUnit = new Map<Unit, Set<NodeId>>();

  /** Register a newly-built unit. `unit.cfg` must already be populated. */
  registerUnit(unit: Unit): void {
    this.unitsByFunctionId.set(unit.funcAst.id, unit);
    this.indexUnitNodes(unit);
  }

  /** Called after `wireCFG` rebuilds a unit's CFG. Unit identity is
   *  preserved; node→unit mapping may change if nodes were added/removed. */
  reindexUnit(unit: Unit): void {
    this.dropUnitNodes(unit);
    this.indexUnitNodes(unit);
  }

  get units(): ReadonlyMap<FunctionId, Unit> {
    return this.unitsByFunctionId;
  }
  unitOfNode(nodeId: NodeId): Unit | undefined {
    return this.unitByNode.get(nodeId);
  }

  private indexUnitNodes(unit: Unit): void {
    const ids = new Set<NodeId>();
    this.nodesByUnit.set(unit, ids);
    for (const id of unit.nodeToBlock.keys()) {
      this.unitByNode.set(id, unit);
      ids.add(id);
    }
  }

  private dropUnitNodes(unit: Unit): void {
    const ids = this.nodesByUnit.get(unit);
    if (ids === undefined) return;
    for (const id of ids) this.unitByNode.delete(id);
    this.nodesByUnit.delete(unit);
  }
}

/** Read-only projection handed to analyses, DfaQuery, transforms, and
 *  narrowings. */
export type ReadonlyProgramTopology = Pick<
  ProgramTopology,
  "units" | "unitOfNode"
>;
