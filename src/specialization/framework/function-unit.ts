import { StmtNS } from "../../ast-types";
import type { FunctionEnvironments } from "../../resolver";
import type { BasicBlock, BlockId, CFG } from "./cfg";
import { buildCFG } from "./cfg";
import type { AnalysisPass } from "./interfaces";
import type { MutableEnv } from "./mutable-env";
import type { SlotLookup } from "./slot-table";
import { buildSlotTable } from "./slot-table";

/**
 * Per-scope optimization unit. `cfg`, `blockMap`, `analysisOuts`, and
 * `generation` are scheduler-owned and replaced wholesale on body-level
 * invalidation (see `Worklist.rebuildAndReseed`). `body` is a read-through
 * getter onto the AST's statement array, which non-monotone transforms
 * splice in place. `analysisOuts[i]` entries are `null` for blocks never
 * processed (unreachable blocks stay `null`). `callCount` persists across
 * CFG rebuilds. The structural version is tracked by `structuralPass` in
 * the fact store; read it via `Worklist.structuralVersionOf(unit)`.
 */
export interface FunctionUnit {
  readonly funcAst: StmtNS.FileInput | StmtNS.FunctionDef;
  readonly slotLookup: SlotLookup;
  readonly body: StmtNS.Stmt[];
  cfg: CFG;
  blockMap: Map<BlockId, BasicBlock>;
  analysisOuts: Map<BlockId, MutableEnv<any> | null>[];
  generation: number;
  callCount: number;
}

/**
 * The `StmtNS.Visitor<void>` dispatch (vs a hand-rolled `instanceof` chain)
 * means any new control-flow form added to `StmtNS.Visitor` forces a
 * compile-time decision here — important for future constructs
 * (try/with/class/method) that introduce blocks. Lambda bodies are a
 * separate scope and not analyzed here.
 */
class ScopeDiscoveryVisitor implements StmtNS.Visitor<void> {
  constructor(
    private readonly units: Map<StmtNS.FileInput | StmtNS.FunctionDef, FunctionUnit>,
    private readonly functionEnvironments: FunctionEnvironments,
    private readonly analyses: readonly AnalysisPass<any>[],
  ) {}

  register(funcAst: StmtNS.FileInput | StmtNS.FunctionDef): void {
    const env = this.functionEnvironments.get(funcAst);
    if (!env) {
      throw new Error(`Environment not found for scope node ${funcAst.kind}`);
    }
    const paramNames =
      funcAst instanceof StmtNS.FileInput ? [] : funcAst.parameters.map(p => p.lexeme);
    const body: StmtNS.Stmt[] =
      funcAst instanceof StmtNS.FileInput ? funcAst.statements : funcAst.body;
    const cfg = buildCFG(body);
    const blockMap = new Map<BlockId, BasicBlock>();
    for (const block of cfg.blocks) blockMap.set(block.id, block);
    const analysisOuts = this.analyses.map(() => makeOut(cfg));
    const unit: FunctionUnit = {
      funcAst,
      slotLookup: buildSlotTable(env, paramNames),
      cfg,
      blockMap,
      analysisOuts,
      generation: 0,
      callCount: 0,
      get body(): StmtNS.Stmt[] {
        return funcAst instanceof StmtNS.FileInput ? funcAst.statements : funcAst.body;
      },
    };
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

  // Leaf / non-block-introducing statements — no recursion, no new scope.
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

/** Fresh OUT map: every block mapped to `null` (never processed). */
export function makeOut<L>(cfg: CFG): Map<BlockId, MutableEnv<L> | null> {
  const out = new Map<BlockId, MutableEnv<L> | null>();
  for (const block of cfg.blocks) out.set(block.id, null);
  return out;
}

export function buildFunctionUnits(
  ast: StmtNS.FileInput,
  functionEnvironments: FunctionEnvironments,
  analyses: readonly AnalysisPass<any>[],
): Map<StmtNS.FileInput | StmtNS.FunctionDef, FunctionUnit> {
  const units = new Map<StmtNS.FileInput | StmtNS.FunctionDef, FunctionUnit>();
  const visitor = new ScopeDiscoveryVisitor(units, functionEnvironments, analyses);
  visitor.register(ast);
  return units;
}
