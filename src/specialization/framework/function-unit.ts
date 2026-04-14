import { StmtNS } from "../../ast-types";
import type { FunctionEnvironments } from "../../resolver";
import type { BasicBlock, BlockId, CFG } from "./cfg";
import { buildCFG } from "./cfg";
import type { SlotLookup } from "./slot-table";
import { buildSlotTable } from "./slot-table";

/** Per-scope optimization unit. CFG fields are scheduler-owned and replaced
 *  by `Worklist.flushPendingRebuilds`. `body` is a live getter onto the AST. */
export interface FunctionUnit {
  readonly funcAst: StmtNS.FileInput | StmtNS.FunctionDef;
  readonly slotLookup: SlotLookup;
  readonly body: StmtNS.Stmt[];
  cfg: CFG;
  blockMap: Map<BlockId, BasicBlock>;
  /** NodeId → containing BasicBlock. */
  blockOfNode: Map<number, BasicBlock>;
  generation: number;
  callCount: number;
}

// Lambda bodies are separate scopes and not analyzed here.
class ScopeDiscoveryVisitor implements StmtNS.Visitor<void> {
  constructor(
    private readonly units: Map<StmtNS.FileInput | StmtNS.FunctionDef, FunctionUnit>,
    private readonly functionEnvironments: FunctionEnvironments,
  ) {}

  register(funcAst: StmtNS.FileInput | StmtNS.FunctionDef): void {
    const env = this.functionEnvironments.get(funcAst);
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
    } as Omit<FunctionUnit, "cfg"> as FunctionUnit;
    wireCFG(unit);
    this.units.set(funcAst, unit);
    for (const stmt of unit.body) stmt.accept(this);
  }

  visitFunctionDefStmt(stmt: StmtNS.FunctionDef): void {
    this.register(stmt);
  }
  visitFileInputStmt(stmt: StmtNS.FileInput): void {
    for (const s of stmt.statements) s.accept(this);
  }
  visitIfStmt(stmt: StmtNS.If): void {
    for (const s of stmt.body) s.accept(this);
    if (stmt.elseBlock) for (const s of stmt.elseBlock) s.accept(this);
  }
  visitWhileStmt(stmt: StmtNS.While): void {
    for (const s of stmt.body) s.accept(this);
  }
  visitForStmt(stmt: StmtNS.For): void {
    for (const s of stmt.body) s.accept(this);
  }

  // Leaf / non-block-introducing statements.
  visitAssignStmt(_stmt: StmtNS.Assign): void {}
  visitAnnAssignStmt(_stmt: StmtNS.AnnAssign): void {}
  visitReturnStmt(_stmt: StmtNS.Return): void {}
  visitSimpleExprStmt(_stmt: StmtNS.SimpleExpr): void {}
  visitAssertStmt(_stmt: StmtNS.Assert): void {}
  visitPassStmt(_stmt: StmtNS.Pass): void {}
  visitBreakStmt(_stmt: StmtNS.Break): void {}
  visitContinueStmt(_stmt: StmtNS.Continue): void {}
  visitGlobalStmt(_stmt: StmtNS.Global): void {}
  visitNonLocalStmt(_stmt: StmtNS.NonLocal): void {}
  visitFromImportStmt(_stmt: StmtNS.FromImport): void {}
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
): Map<StmtNS.FileInput | StmtNS.FunctionDef, FunctionUnit> {
  const units = new Map<StmtNS.FileInput | StmtNS.FunctionDef, FunctionUnit>();
  const visitor = new ScopeDiscoveryVisitor(units, functionEnvironments);
  visitor.register(ast);
  return units;
}
