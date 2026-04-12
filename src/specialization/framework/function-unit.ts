import { StmtNS } from "../../ast-types";
import type { FunctionEnvironments } from "../../resolver";
import { HintStore } from "./hint";
import type { AnalysisKey } from "./hint";
import type { SlotLookup } from "./slot-table";
import { buildSlotTable } from "./slot-table";

type Scope = StmtNS.FileInput | StmtNS.FunctionDef;

/**
 * Per-scope optimization unit: owns its body, hints, slot lookup, and a
 * `structuralVersion` that the worklist bumps on each AST-mutating transform.
 * Consumers comparing structure across time should watch `structuralVersion`;
 * consumers watching annotations should read `hints.version` directly.
 */
export interface FunctionUnit {
  readonly funcAst: StmtNS.FileInput | StmtNS.FunctionDef;
  readonly body: StmtNS.Stmt[];
  readonly hints: HintStore;
  readonly slotLookup: SlotLookup;
  structuralVersion: number;
}

/**
 * Build a flat map of scope node → FunctionUnit.
 *
 * Walks scope boundaries (FileInput → FunctionDef → nested defs). Lambda is
 * skipped (DFA does not analyze single-expression lambda bodies).
 */
export function buildFunctionUnits(
  ast: StmtNS.FileInput,
  functionEnvironments: FunctionEnvironments,
  analysisKeys?: readonly AnalysisKey<unknown>[],
): Map<Scope, FunctionUnit> {
  const units = new Map<Scope, FunctionUnit>();

  function buildUnit(funcAst: Scope): void {
    const env = functionEnvironments.get(funcAst);
    if (!env) {
      throw new Error(`Environment not found for scope node ${funcAst.kind}`);
    }

    const body = funcAst instanceof StmtNS.FileInput ? funcAst.statements : funcAst.body;
    const paramNames = funcAst instanceof StmtNS.FileInput ? [] : funcAst.parameters.map(p => p.lexeme);

    units.set(funcAst, {
      funcAst,
      body,
      hints: new HintStore(analysisKeys),
      slotLookup: buildSlotTable(env, paramNames),
      structuralVersion: 0,
    });

    for (const stmt of body) collectNested(stmt, buildUnit);
  }

  buildUnit(ast);
  return units;
}

function collectNested(stmt: StmtNS.Stmt, buildUnit: (f: Scope) => void): void {
  if (stmt instanceof StmtNS.FunctionDef) {
    buildUnit(stmt);
  } else if (stmt instanceof StmtNS.If) {
    for (const s of stmt.body) collectNested(s, buildUnit);
    if (stmt.elseBlock) for (const s of stmt.elseBlock) collectNested(s, buildUnit);
  } else if (stmt instanceof StmtNS.While) {
    for (const s of stmt.body) collectNested(s, buildUnit);
  } else if (stmt instanceof StmtNS.For) {
    for (const s of stmt.body) collectNested(s, buildUnit);
  }
}
