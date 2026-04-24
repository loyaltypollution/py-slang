import { StmtNS } from "../../ast-types";
import type { FunctionEnvironments } from "../../resolver";
import type { NodeId } from "./analysis";
import type { BasicBlock, BlockId, CFG } from "./cfg";
import { buildCFG } from "./cfg";
import type { SlotLookup } from "./slot-table";
import { buildSlotTable } from "./slot-table";

/** Per-scope optimization unit. `cfg` and `blockMap` are scheduler-owned
 *  and replaced by `Worklist.flushPendingRebuilds`. `body` is a live getter
 *  onto the AST. Function identity lives on `funcAst.id`; bytecode slot
 *  numbering (if any) is a backend concern and lives on the backend's own
 *  table (e.g. `SvmlSlotTable`). */
export interface Unit {
  readonly funcAst: StmtNS.FileInput | StmtNS.FunctionDef;
  readonly slotLookup: SlotLookup;
  readonly body: StmtNS.Stmt[];
  cfg: CFG;
  blockMap: Map<BlockId, BasicBlock>;
  /** Node id → enclosing basic block, rebuilt with `wireCFG`. */
  nodeToBlock: Map<NodeId, BasicBlock>;
  generation: number;
  blockOfNode(nodeId: NodeId): BasicBlock | undefined;
}

/** Build a single Unit for `funcAst` — no recursion into nested scopes. */
export function buildOneUnit(
  funcAst: StmtNS.FileInput | StmtNS.FunctionDef,
  functionEnvironments: FunctionEnvironments,
): Unit {
  const env = functionEnvironments.get(funcAst);
  if (!env) {
    throw new Error(`Environment not found for scope node ${funcAst.kind}`);
  }
  const paramNames =
    funcAst instanceof StmtNS.FileInput ? [] : funcAst.parameters.map(p => p.lexeme);
  const unit = {
    funcAst,
    slotLookup: buildSlotTable(env, paramNames),
    blockMap: new Map(),
    nodeToBlock: new Map<NodeId, BasicBlock>(),
    generation: 0,
    get body(): StmtNS.Stmt[] {
      return funcAst instanceof StmtNS.FileInput ? funcAst.statements : funcAst.body;
    },
    blockOfNode(nodeId: NodeId): BasicBlock | undefined {
      return (this as Unit).nodeToBlock.get(nodeId);
    },
  } as Omit<Unit, "cfg"> as Unit;
  wireCFG(unit);
  return unit;
}

// Lambda bodies are separate scopes and not analyzed here.

/** (Re)build `unit.cfg`, refresh `blockMap`, and reindex `nodeToBlock`. The
 *  topology reindexes its own flat `NodeId → Unit` map separately. */
export function wireCFG(unit: Unit): void {
  unit.cfg = buildCFG(unit.body, unit);
  const blockMap = new Map<BlockId, BasicBlock>();
  for (const block of unit.cfg.blocks) {
    blockMap.set(block.id, block);
  }
  unit.blockMap = blockMap;
  const nodeToBlock = new Map<NodeId, BasicBlock>();
  for (const block of unit.cfg.blocks) {
    for (const stmt of block.stmts) {
      walkAstNodeIds(stmt, block, nodeToBlock);
    }
  }
  unit.nodeToBlock = nodeToBlock;
}

function walkAstNodeIds(
  node: unknown,
  block: BasicBlock,
  out: Map<NodeId, BasicBlock>,
  seen: WeakSet<object> = new WeakSet(),
): void {
  if (node === null || typeof node !== "object") return;
  if (seen.has(node as object)) return;
  seen.add(node as object);
  const obj = node as Record<string, unknown>;
  const id = obj.id;
  if (typeof id === "number") out.set(id, block);
  for (const key of Object.keys(obj)) {
    const child = obj[key];
    if (Array.isArray(child)) {
      for (const item of child) walkAstNodeIds(item, block, out, seen);
    } else if (typeof child === "object" && child !== null) {
      walkAstNodeIds(child, block, out, seen);
    }
  }
}

export function buildUnits(
  ast: StmtNS.FileInput,
  functionEnvironments: FunctionEnvironments,
): Map<StmtNS.FileInput | StmtNS.FunctionDef, Unit> {
  const units = new Map<StmtNS.FileInput | StmtNS.FunctionDef, Unit>();
  const rootUnit = buildOneUnit(ast, functionEnvironments);
  units.set(ast, rootUnit);

  const visit = (stmts: ReadonlyArray<StmtNS.Stmt>): void => {
    for (const stmt of stmts) {
      if (stmt instanceof StmtNS.FunctionDef) {
        const unit = buildOneUnit(stmt, functionEnvironments);
        units.set(stmt, unit);
        visit(unit.body);
      } else if (stmt instanceof StmtNS.If) {
        visit(stmt.body);
        if (stmt.elseBlock) visit(stmt.elseBlock);
      } else if (stmt instanceof StmtNS.While || stmt instanceof StmtNS.For) {
        visit(stmt.body);
      }
    }
  };
  visit(rootUnit.body);
  return units;
}
