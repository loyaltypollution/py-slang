import { StmtNS } from "../../ast-types";
import type { FunctionEnvironments } from "../../resolver";
import type { FunctionRegistry } from "./function-registry";
import type { BasicBlock, BlockId, CFG } from "./cfg";
import { buildCFG } from "./cfg";
import type { SlotLookup } from "./slot-table";
import { buildSlotTable } from "./slot-table";

/** Per-scope optimization unit. CFG fields are scheduler-owned and replaced
 *  by `Worklist.flushPendingRebuilds`. `body` is a live getter onto the AST.
 *  `slot` delegates to the shared `FunctionRegistry` so slot identity is
 *  single-sourced: worklist and compiler cannot disagree. */
export interface FunctionUnit {
  readonly funcAst: StmtNS.FileInput | StmtNS.FunctionDef;
  readonly slotLookup: SlotLookup;
  readonly body: StmtNS.Stmt[];
  /** Bytecode slot — delegated to the shared FunctionRegistry. */
  readonly slot: number;
  cfg: CFG;
  blockMap: Map<BlockId, BasicBlock>;
  /** NodeId → containing BasicBlock. */
  blockOfNode: Map<number, BasicBlock>;
  generation: number;
  callCount: number;
}

/** Build a single FunctionUnit for `funcAst` — no recursion into nested
 *  scopes. The initial construction walk (`ScopeDiscoveryVisitor`) drives
 *  recursion itself; mid-run on-mint handling wants exactly one unit per
 *  mint event. */
export function buildOneFunctionUnit(
  funcAst: StmtNS.FileInput | StmtNS.FunctionDef,
  functionEnvironments: FunctionEnvironments,
  registry: FunctionRegistry,
): FunctionUnit {
  const env = functionEnvironments.get(funcAst);
  if (!env) {
    throw new Error(`Environment not found for scope node ${funcAst.kind}`);
  }
  const paramNames =
    funcAst instanceof StmtNS.FileInput ? [] : funcAst.parameters.map(p => p.lexeme);
  // blocks hold unit back-pointers; unit owns cfg. Build shell, then wireCFG.
  const unit = {
    funcAst,
    slotLookup: buildSlotTable(env, paramNames),
    blockMap: new Map(),
    blockOfNode: new Map(),
    generation: 0,
    callCount: 0,
    get body(): StmtNS.Stmt[] {
      return funcAst instanceof StmtNS.FileInput ? funcAst.statements : funcAst.body;
    },
    get slot(): number {
      return registry.slotOfNode(funcAst);
    },
  } as Omit<FunctionUnit, "cfg"> as FunctionUnit;
  wireCFG(unit);
  return unit;
}

// Lambda bodies are separate scopes and not analyzed here.
function discoverScopes(
  stmts: ReadonlyArray<StmtNS.Stmt>,
  units: Map<StmtNS.FileInput | StmtNS.FunctionDef, FunctionUnit>,
  functionEnvironments: FunctionEnvironments,
  registry: FunctionRegistry,
): void {
  for (const stmt of stmts) {
    if (stmt instanceof StmtNS.FunctionDef) {
      const unit = buildOneFunctionUnit(stmt, functionEnvironments, registry);
      units.set(stmt, unit);
      discoverScopes(unit.body, units, functionEnvironments, registry);
    } else if (stmt instanceof StmtNS.If) {
      discoverScopes(stmt.body, units, functionEnvironments, registry);
      if (stmt.elseBlock) discoverScopes(stmt.elseBlock, units, functionEnvironments, registry);
    } else if (stmt instanceof StmtNS.While || stmt instanceof StmtNS.For) {
      discoverScopes(stmt.body, units, functionEnvironments, registry);
    }
  }
}

/** (Re)build `unit.cfg` and refresh `blockMap` / `blockOfNode`.
 *  Block `unit` back-pointers are set at block creation by `buildCFG`. */
export function wireCFG(unit: FunctionUnit): void {
  unit.cfg = buildCFG(unit.body, unit);
  const blockMap = new Map<BlockId, BasicBlock>();
  const blockOfNode = new Map<number, BasicBlock>();
  for (const block of unit.cfg.blocks) {
    blockMap.set(block.id, block);
    for (const stmt of block.stmts) populateBlockOfNode(stmt, block, blockOfNode);
  }
  unit.blockMap = blockMap;
  unit.blockOfNode = blockOfNode;
}

function populateBlockOfNode(
  node: unknown,
  block: BasicBlock,
  out: Map<number, BasicBlock>,
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
      for (const item of child) populateBlockOfNode(item, block, out, seen);
    } else if (typeof child === "object" && child !== null) {
      populateBlockOfNode(child, block, out, seen);
    }
  }
}

export function buildFunctionUnits(
  ast: StmtNS.FileInput,
  functionEnvironments: FunctionEnvironments,
  registry: FunctionRegistry,
): Map<StmtNS.FileInput | StmtNS.FunctionDef, FunctionUnit> {
  const units = new Map<StmtNS.FileInput | StmtNS.FunctionDef, FunctionUnit>();
  const rootUnit = buildOneFunctionUnit(ast, functionEnvironments, registry);
  units.set(ast, rootUnit);
  discoverScopes(rootUnit.body, units, functionEnvironments, registry);
  return units;
}
