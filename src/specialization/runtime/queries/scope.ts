// src/specialization/runtime/queries/scope.ts — scope-keyed queries
//
// Phase 3e (architecture-most-correct.md): port `purityScopePass`,
// `callCountPass`, and the MemoizationTransformRule gate onto the runtime
// layer as pure queries. All three are keyed by scope id (FunctionDef.id
// for function scopes; top-level FileInput returns `undefined` since
// purity is only meaningful for FunctionDefs — matches migrated-passes).
//
// Early-cutoff shape:
//   - `callCountOf` projects the saturating lattice already enforced at
//     the `runtimeCall` input layer. Since writes past THRESHOLD are
//     lattice-equal at input time (see runtime/inputs.ts), the dependent
//     chain bottoms out at the first saturating write.
//   - `purityOf` depends only on AST+CFG structure, so once a scope's
//     body stabilises it never recomputes from call-count changes.
//   - `shouldMemoize`'s inputs are both monotone; once both stabilise at
//     `(>=THRESHOLD, pure)` or `(_, impure)` the boolean is pinned.

import { StmtNS } from "../../../ast-types";
import { buildCFG, type CFG } from "../../framework/cfg";
import { buildSlotTable, type SlotLookup } from "../../framework/slot-table";
import { computePurityFromParts } from "../../purity-analysis/analysis";
import { MEMOIZATION_THRESHOLD } from "../../memoization-analysis/call-count";
import type { Db } from "../db";
import { astOf, environmentsOf, runtimeCall } from "../inputs";
import type { Lattice } from "../lattice";
import { defineQuery, type QueryHandle } from "../query";

const UNIT_ID = 0;

// ── callCountOf ──────────────────────────────────────────────────────────

const countLattice: Lattice<number> = {
  bottom: 0,
  equals: (a, b) => a === b,
  join: Math.max,
};

// Saturating projection. `runtimeCall`'s input lattice already caps at 50,
// but we cap again at MEMOIZATION_THRESHOLD so `shouldMemoize`'s upstream
// saturates at the actual firing boundary (dissolving the re-fire path
// legacy `callCountPass` needed).
export const callCountOf: QueryHandle<number, number> = defineQuery<number, number>({
  name: "callCountOf",
  lattice: countLattice,
  serialize: String,
  fn: (db, scopeId) => Math.min(runtimeCall.get(db, scopeId), MEMOIZATION_THRESHOLD),
});

// ── purityOf ─────────────────────────────────────────────────────────────

type PurityVerdict = "pure" | "impure" | "contested" | undefined;

const purityLattice: Lattice<PurityVerdict> = {
  bottom: undefined,
  equals: (a, b) => a === b,
  // Matches migrated-passes: two writers can disagree, but here we're the
  // sole writer — `contested` is unreachable from this query's fn. Kept
  // in the join for lattice-correctness so the shape matches Phase 2's
  // spec contract.
  join: (a, b) => {
    if (a === undefined) return b;
    if (b === undefined) return a;
    if (a === b) return a;
    return "contested";
  },
};

// Walk the FileInput AST to find a FunctionDef by id. Pure traversal over
// the Stmt.Visitor variants that introduce scopes; lambda bodies are a
// separate scope in the grammar but have no FunctionDef id so they're
// invisible here.
function findFunctionDef(
  root: StmtNS.FileInput,
  id: number,
): StmtNS.FunctionDef | undefined {
  let found: StmtNS.FunctionDef | undefined;
  const walk = (stmts: readonly StmtNS.Stmt[]): void => {
    for (const s of stmts) {
      if (found !== undefined) return;
      if (s instanceof StmtNS.FunctionDef) {
        if (s.id === id) { found = s; return; }
        walk(s.body);
      } else if (s instanceof StmtNS.If) {
        walk(s.body);
        if (s.elseBlock) walk(s.elseBlock);
      } else if (s instanceof StmtNS.While) {
        walk(s.body);
      } else if (s instanceof StmtNS.For) {
        walk(s.body);
      }
    }
  };
  walk(root.statements);
  return found;
}

export const purityOf: QueryHandle<number, PurityVerdict> = defineQuery<
  number,
  PurityVerdict
>({
  name: "purityOf",
  lattice: purityLattice,
  serialize: String,
  fn: (db, scopeId) => {
    const ast = astOf.get(db, UNIT_ID);
    if (ast === undefined) return undefined;
    const envs = environmentsOf.get(db, UNIT_ID);
    if (envs === undefined) return undefined;

    const fd = findFunctionDef(ast, scopeId);
    if (fd === undefined) return undefined;

    const env = envs.get(fd);
    if (env === undefined) return undefined;

    const paramNames = fd.parameters.map((p) => p.lexeme);
    const slotLookup: SlotLookup = buildSlotTable(env, paramNames);
    const cfg: CFG = buildCFG(fd.body);

    const verdict = computePurityFromParts(fd, cfg, slotLookup);
    if (verdict === undefined) return undefined;
    return verdict ? "pure" : "impure";
  },
});

// ── shouldMemoize ────────────────────────────────────────────────────────

const boolLattice: Lattice<boolean> = {
  bottom: false,
  equals: (a, b) => a === b,
  join: (a, b) => a || b,
};

// Pure composition; early-cutoff rides on its inputs. Once `callCountOf`
// saturates at MEMOIZATION_THRESHOLD and `purityOf` stabilises, this cell
// stops re-running.
export const shouldMemoize: QueryHandle<number, boolean> = defineQuery<number, boolean>({
  name: "shouldMemoize",
  lattice: boolLattice,
  serialize: String,
  fn: (db, scopeId) => {
    const count = db.get(callCountOf, scopeId);
    const purity = db.get(purityOf, scopeId);
    return count >= MEMOIZATION_THRESHOLD && purity === "pure";
  },
});
