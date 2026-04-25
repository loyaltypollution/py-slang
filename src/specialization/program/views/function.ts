import { ExprNS, StmtNS } from "../../../ast-types";
import type { FunctionEnvironments } from "../../../resolver";
import type { NodeId } from "../node-set";
import type { BasicBlock, BlockId, CFG } from "./basic-block";
import { buildCFG } from "./basic-block";
import type { SlotLookup } from "../slot-table";
import { buildSlotTable } from "../slot-table";

/** Per-scope optimization unit. `cfg` and `blockMap` are scheduler-owned
 *  and replaced by `Worklist.flushPendingRebuilds`. `body` is a live getter
 *  onto the AST. Function identity is `funcAst.id`. */
export interface Function {
  readonly funcAst: StmtNS.FileInput | StmtNS.FunctionDef;
  readonly slotLookup: SlotLookup;
  readonly body: StmtNS.Stmt[];
  cfg: CFG;
  blockMap: Map<BlockId, BasicBlock>;
  nodeToBlock: Map<NodeId, BasicBlock>;
  blockOfNode(nodeId: NodeId): BasicBlock | undefined;
  contains(n: NodeId): boolean;
  readonly size: number;
  iterate(): Iterable<NodeId>;
}

/** Build a single Function for `funcAst` — no recursion into nested scopes. */
export function buildOneFunction(
  funcAst: StmtNS.FileInput | StmtNS.FunctionDef,
  functionEnvironments: FunctionEnvironments,
): Function {
  const env = functionEnvironments.get(funcAst);
  if (!env) {
    throw new Error(`Environment not found for scope node ${funcAst.kind}`);
  }
  const paramNames =
    funcAst instanceof StmtNS.FileInput ? [] : funcAst.parameters.map(p => p.lexeme);
  const unit: Function = {
    funcAst,
    slotLookup: buildSlotTable(env, paramNames),
    cfg: undefined as unknown as CFG,
    blockMap: new Map(),
    nodeToBlock: new Map<NodeId, BasicBlock>(),
    get body(): StmtNS.Stmt[] {
      return funcAst instanceof StmtNS.FileInput ? funcAst.statements : funcAst.body;
    },
    blockOfNode(nodeId) {
      return unit.nodeToBlock.get(nodeId);
    },
    contains(nodeId) {
      return unit.nodeToBlock.has(nodeId);
    },
    get size(): number {
      return unit.nodeToBlock.size;
    },
    iterate() {
      return unit.nodeToBlock.keys();
    },
  };
  wireCFG(unit);
  return unit;
}

/** (Re)build `unit.cfg`, refresh `blockMap`, and reindex `nodeToBlock`. The
 *  topology reindexes its own flat `NodeId → Function` map separately. */
export function wireCFG(unit: Function): void {
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
  if (seen.has(node)) return;
  seen.add(node);
  const obj = node as Record<string, unknown>;
  const id = obj.id;
  if (typeof id === "number") {
    out.set(id, block);
    block.nodeIds.add(id);
  }
  for (const key of Object.keys(obj)) {
    if (isNestedScopeOrCfgBody(node, key)) continue;
    const child = obj[key];
    if (Array.isArray(child)) {
      for (const item of child) walkAstNodeIds(item, block, out, seen);
    } else if (typeof child === "object" && child !== null) {
      walkAstNodeIds(child, block, out, seen);
    }
  }
}

/** `BasicBlock` membership is exclusive CFG ownership, not syntactic subtree
 *  containment. Header blocks own their predicate/iter expression; body
 *  statements belong to the blocks `buildCFG` emitted for those bodies.
 *  Nested function/lambda bodies are separate scopes. */
function isNestedScopeOrCfgBody(node: unknown, key: string): boolean {
  if (node instanceof StmtNS.If) return key === "body" || key === "elseBlock";
  if (node instanceof StmtNS.While || node instanceof StmtNS.For) return key === "body";
  if (node instanceof StmtNS.FunctionDef) return key === "body" || key === "varDecls";
  if (node instanceof ExprNS.Lambda || node instanceof ExprNS.MultiLambda) return key === "body";
  return false;
}

export function buildFunctions(
  ast: StmtNS.FileInput,
  functionEnvironments: FunctionEnvironments,
): Map<StmtNS.FileInput | StmtNS.FunctionDef, Function> {
  const functions = new Map<StmtNS.FileInput | StmtNS.FunctionDef, Function>();
  const rootUnit = buildOneFunction(ast, functionEnvironments);
  functions.set(ast, rootUnit);

  const visit = (stmts: ReadonlyArray<StmtNS.Stmt>): void => {
    for (const stmt of stmts) {
      if (stmt instanceof StmtNS.FunctionDef) {
        const unit = buildOneFunction(stmt, functionEnvironments);
        functions.set(stmt, unit);
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
  return functions;
}
