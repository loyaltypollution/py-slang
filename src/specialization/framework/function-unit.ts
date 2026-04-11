import { StmtNS } from "../../ast-types";
import type { FunctionEnvironments } from "../../resolver";
import { HintStore } from "./hint";
import type { SlotLookup } from "./slot-table";
import { buildSlotTable } from "./slot-table";

/**
 * Per-scope optimization unit: owns its body, hints, and slot lookup.
 */
export interface FunctionUnit {
  readonly funcAst: StmtNS.FileInput | StmtNS.FunctionDef;
  readonly body: StmtNS.Stmt[];
  readonly hints: HintStore;
  readonly slotLookup: SlotLookup;
}

/**
 * Build a flat map of scope node → FunctionUnit from an AST and its resolved environments.
 *
 * Walks scope boundaries (FileInput → FunctionDef → nested defs) and builds
 * one FunctionUnit per scope. Lambda is skipped (DFA does not analyze
 * single-expression lambda bodies).
 */
export function buildFunctionUnits(
  ast: StmtNS.FileInput,
  functionEnvironments: FunctionEnvironments,
): Map<StmtNS.FileInput | StmtNS.FunctionDef, FunctionUnit> {
  const units = new Map<StmtNS.FileInput | StmtNS.FunctionDef, FunctionUnit>();

  function buildUnit(funcAst: StmtNS.FileInput | StmtNS.FunctionDef): void {
    const env = functionEnvironments.get(funcAst);
    if (!env) {
      throw new Error(`Environment not found for scope node ${funcAst.kind}`);
    }

    const body = funcAst instanceof StmtNS.FileInput ? funcAst.statements : funcAst.body;
    const paramNames = funcAst instanceof StmtNS.FileInput ? [] : funcAst.parameters.map(p => p.lexeme);

    units.set(funcAst, {
      funcAst,
      body,
      hints: new HintStore(),
      slotLookup: buildSlotTable(env, paramNames),
    });

    // Recurse into nested function definitions (shallow walk — stop at function boundaries)
    function collectFrom(stmts: StmtNS.Stmt[]): void {
      for (const stmt of stmts) {
        if (stmt instanceof StmtNS.FunctionDef) {
          buildUnit(stmt);
        } else if (stmt instanceof StmtNS.If) {
          collectFrom(stmt.body);
          if (stmt.elseBlock) collectFrom(stmt.elseBlock);
        } else if (stmt instanceof StmtNS.While) {
          collectFrom(stmt.body);
        } else if (stmt instanceof StmtNS.For) {
          collectFrom(stmt.body);
        }
      }
    }
    collectFrom(body);
  }

  buildUnit(ast);
  return units;
}
