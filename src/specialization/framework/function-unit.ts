import { StmtNS } from "../../ast-types";
import type { FunctionEnvironments } from "../../resolver";
import type { FunctionRegistry } from "./function-registry";
import type { BasicBlock, BlockId, CFG } from "./cfg";
import { buildCFG } from "./cfg";
import type { SlotLookup } from "./slot-table";
import { buildSlotTable } from "./slot-table";

/** Per-scope optimization unit. `cfg` and `blockMap` are scheduler-owned
 *  and replaced by `Worklist.flushPendingRebuilds`. `body` is a live getter
 *  onto the AST. `slot` delegates to the shared `FunctionRegistry`. */
export interface Unit {
  readonly funcAst: StmtNS.FileInput | StmtNS.FunctionDef;
  readonly slotLookup: SlotLookup;
  readonly body: StmtNS.Stmt[];
  /** Bytecode slot — delegated to the shared FunctionRegistry. */
  readonly slot: number;
  cfg: CFG;
  blockMap: Map<BlockId, BasicBlock>;
  generation: number;
}

/** Build a single Unit for `funcAst` — no recursion into nested scopes. */
export function buildOneUnit(
  funcAst: StmtNS.FileInput | StmtNS.FunctionDef,
  functionEnvironments: FunctionEnvironments,
  registry: FunctionRegistry,
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
    generation: 0,
    get body(): StmtNS.Stmt[] {
      return funcAst instanceof StmtNS.FileInput ? funcAst.statements : funcAst.body;
    },
    get slot(): number {
      return registry.slotOfNode(funcAst);
    },
  } as Omit<Unit, "cfg"> as Unit;
  wireCFG(unit);
  return unit;
}

// Lambda bodies are separate scopes and not analyzed here.
function discoverScopes(
  stmts: ReadonlyArray<StmtNS.Stmt>,
  units: Map<StmtNS.FileInput | StmtNS.FunctionDef, Unit>,
  functionEnvironments: FunctionEnvironments,
  registry: FunctionRegistry,
): void {
  const recurse = (inner: ReadonlyArray<StmtNS.Stmt>): void =>
    discoverScopes(inner, units, functionEnvironments, registry);

  for (const stmt of stmts) {
    if (stmt instanceof StmtNS.FunctionDef) {
      const unit = buildOneUnit(stmt, functionEnvironments, registry);
      units.set(stmt, unit);
      recurse(unit.body);
    } else if (stmt instanceof StmtNS.If) {
      recurse(stmt.body);
      if (stmt.elseBlock) recurse(stmt.elseBlock);
    } else if (stmt instanceof StmtNS.While || stmt instanceof StmtNS.For) {
      recurse(stmt.body);
    }
  }
}

/** (Re)build `unit.cfg` and refresh `blockMap`. Node → block indexing is
 *  rebuilt separately by `ProgramTopology.reindexUnit(unit)`. */
export function wireCFG(unit: Unit): void {
  unit.cfg = buildCFG(unit.body, unit);
  const blockMap = new Map<BlockId, BasicBlock>();
  for (const block of unit.cfg.blocks) {
    blockMap.set(block.id, block);
  }
  unit.blockMap = blockMap;
}

export function buildUnits(
  ast: StmtNS.FileInput,
  functionEnvironments: FunctionEnvironments,
  registry: FunctionRegistry,
): Map<StmtNS.FileInput | StmtNS.FunctionDef, Unit> {
  const units = new Map<StmtNS.FileInput | StmtNS.FunctionDef, Unit>();
  const rootUnit = buildOneUnit(ast, functionEnvironments, registry);
  units.set(ast, rootUnit);
  discoverScopes(rootUnit.body, units, functionEnvironments, registry);
  return units;
}
