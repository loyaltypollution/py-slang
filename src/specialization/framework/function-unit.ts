import { StmtNS } from "../../ast-types";
import type { FunctionEnvironments } from "../../resolver";
import type { BasicBlock, BlockId, CFG } from "./cfg";
import { buildCFG } from "./cfg";
import { HintStore, type OptimizationHint } from "./hint";
import type { AnalysisPass } from "./interfaces";
import type { MutableEnv } from "./mutable-env";
import type { SlotLookup } from "./slot-table";
import { buildSlotTable } from "./slot-table";

type HintEq = (a: OptimizationHint, b: OptimizationHint) => boolean;

/**
 * Per-scope optimization unit. Aggregates scope-keyed state: the AST node
 * identity (immutable), the mutable runtime state the framework maintains
 * alongside it, and the scheduler's per-scope DFA working memory (CFG,
 * block index, per-analysis OUT maps, generation counter).
 *
 * The scheduler-owned fields (`cfg`, `blockMap`, `analysisOuts`,
 * `generation`) are replaced wholesale on every body-level invalidation —
 * see `Worklist.rebuildAndReseed`. Collapsing them onto the unit removes
 * a parallel `scopes` map that used to mirror `units` 1:1.
 *
 * Mutability split:
 *   - Immutable identity / wiring: `funcAst`, `slotLookup`. Set at
 *     construction, never rewritten.
 *   - Mutable runtime state:
 *     - `hints` — readonly reference but `HintStore.set` mutates contents.
 *     - `body` — readonly reference (read-through getter onto the AST's
 *       statement array); array contents are spliced in place by
 *       non-monotone transforms (memoization, dead-branch elimination).
 *     - `structuralVersion` — bumped by every successful transform.
 *   - Mutable scheduler state (owned by `Worklist`):
 *     - `cfg`, `blockMap` — rebuilt on every body invalidation.
 *     - `analysisOuts[i]` — per-analysis OUT environment per block.
 *       `null` means "never processed"; unreachable blocks stay `null`.
 *     - `generation` — bumped on every reseed; stale queue items that
 *       mention an older generation are dropped.
 */
export interface FunctionUnit {
  readonly funcAst: StmtNS.FileInput | StmtNS.FunctionDef;
  readonly hints: HintStore;
  readonly slotLookup: SlotLookup;
  readonly body: StmtNS.Stmt[];
  structuralVersion: number;
  cfg: CFG;
  blockMap: Map<BlockId, BasicBlock>;
  analysisOuts: Map<BlockId, MutableEnv<any> | null>[];
  generation: number;
  /**
   * Raw call observations recorded since the worklist was constructed.
   * Append-only: `observeCall` pushes `(callerKey, calleeKey)` pairs where
   * this unit is the callee. Read by ScopePasses (e.g. CallCountScopePass)
   * and then folded into a scope-level hint. Deliberately not reset on
   * rebuild — call counts are monotone over the worklist's lifetime.
   */
  callObservations: Array<{
    readonly callerKey: StmtNS.FileInput | StmtNS.FunctionDef;
    readonly calleeKey: StmtNS.FileInput | StmtNS.FunctionDef;
  }>;
}

/**
 * Walks every statement subtree through a `StmtNS.Visitor<void>` and
 * registers each `FunctionDef` as its own unit. The visitor dispatch (vs
 * a hand-rolled `instanceof` chain) means any new control-flow form added
 * to `StmtNS.Visitor` forces a compile-time decision here — important for
 * future constructs (try/with/class/method) that introduce blocks.
 *
 * Lambda bodies are a separate scope and not analyzed here (DFA does not
 * analyze single-expression lambda bodies).
 */
class ScopeDiscoveryVisitor implements StmtNS.Visitor<void> {
  constructor(
    private readonly units: Map<StmtNS.FileInput | StmtNS.FunctionDef, FunctionUnit>,
    private readonly functionEnvironments: FunctionEnvironments,
    private readonly hintEq: HintEq,
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
      hints: new HintStore(this.hintEq),
      slotLookup: buildSlotTable(env, paramNames),
      structuralVersion: 0,
      cfg,
      blockMap,
      analysisOuts,
      generation: 0,
      callObservations: [],
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

/**
 * Fresh per-analysis OUT map for a CFG: every block mapped to `null`
 * (never processed). The scheduler overwrites entries as it transfers
 * blocks.
 */
export function makeOut<L>(cfg: CFG): Map<BlockId, MutableEnv<L> | null> {
  const out = new Map<BlockId, MutableEnv<L> | null>();
  for (const block of cfg.blocks) out.set(block.id, null);
  return out;
}

export function buildFunctionUnits(
  ast: StmtNS.FileInput,
  functionEnvironments: FunctionEnvironments,
  hintEq: HintEq,
  analyses: readonly AnalysisPass<any>[],
): Map<StmtNS.FileInput | StmtNS.FunctionDef, FunctionUnit> {
  const units = new Map<StmtNS.FileInput | StmtNS.FunctionDef, FunctionUnit>();
  const visitor = new ScopeDiscoveryVisitor(units, functionEnvironments, hintEq, analyses);
  visitor.register(ast);
  return units;
}
