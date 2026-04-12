import { StmtNS } from "../../ast-types";
import type { FunctionEnvironments } from "../../resolver";
import { HintStore } from "./hint";
import type { LatticeEquality } from "./hint";
import type { SlotLookup } from "./slot-table";
import { buildSlotTable } from "./slot-table";

/**
 * Per-scope optimization unit. `body` is a read-through getter onto the
 * AST's statement array so consumers can never observe a stale cached
 * array if memoization or another non-monotone transform swaps the
 * subtree.
 */
export interface FunctionUnit {
  readonly funcAst: StmtNS.FileInput | StmtNS.FunctionDef;
  readonly hints: HintStore;
  readonly slotLookup: SlotLookup;
  readonly body: StmtNS.Stmt[];
  structuralVersion: number;
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
    private readonly analysisModules: readonly LatticeEquality[] | undefined,
  ) {}

  register(funcAst: StmtNS.FileInput | StmtNS.FunctionDef): void {
    const env = this.functionEnvironments.get(funcAst);
    if (!env) {
      throw new Error(`Environment not found for scope node ${funcAst.kind}`);
    }
    const paramNames =
      funcAst instanceof StmtNS.FileInput ? [] : funcAst.parameters.map(p => p.lexeme);
    const unit: FunctionUnit = {
      funcAst,
      hints: new HintStore(this.analysisModules),
      slotLookup: buildSlotTable(env, paramNames),
      structuralVersion: 0,
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

export function buildFunctionUnits(
  ast: StmtNS.FileInput,
  functionEnvironments: FunctionEnvironments,
  analysisModules?: readonly LatticeEquality[],
): Map<StmtNS.FileInput | StmtNS.FunctionDef, FunctionUnit> {
  const units = new Map<StmtNS.FileInput | StmtNS.FunctionDef, FunctionUnit>();
  const visitor = new ScopeDiscoveryVisitor(units, functionEnvironments, analysisModules);
  visitor.register(ast);
  return units;
}
