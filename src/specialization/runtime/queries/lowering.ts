// src/specialization/runtime/queries/lowering.ts — Phase 4 lowering queries.
//
// Chain: astOf → astAfterDeadBranch → astAfterConstFold → astAfterMemoize
//                                                          → optimizedAstOf
//
// Each stage reads the previous stage's AST plus relevant fact queries via
// `db.get`, and delegates the actual rewrite to pure (AST, facts) → AST
// helpers in `../../transforms/pure-rewrites.ts`.
//
// Early-cutoff invariant: every stage returns its input AST reference
// unchanged when its rewrite has nothing to do (see `pure-rewrites.ts` for
// the structural-sharing implementation). Combined with `equals: ===`, an
// unchanged stage snaps green without waking downstream dependents.

import { StmtNS } from "../../../ast-types";
import {
  rewriteDeadBranch,
  rewriteConstantFold,
  rewriteMemoize,
} from "../../transforms/pure-rewrites";
import { astOf } from "../inputs";
import type { Lattice } from "../lattice";
import { defineQuery, type QueryHandle } from "../query";
import { constOf } from "./const-of";
import { shouldMemoize } from "./scope";

// Shared lattice for every stage: last-write-wins, `===`-equality. This
// matches cfgOf's shape (see `cfg.ts`) — lattice-equals snaps green, any
// new reference propagates.
const astLattice: Lattice<StmtNS.FileInput | undefined> = {
  bottom: undefined,
  equals: (a, b) => a === b,
  join: (_a, b) => b,
};

export const astAfterDeadBranch: QueryHandle<
  number,
  StmtNS.FileInput | undefined
> = defineQuery<number, StmtNS.FileInput | undefined>({
  name: "astAfterDeadBranch",
  lattice: astLattice,
  serialize: String,
  fn: (db, unitId) => {
    const ast = astOf.get(db, unitId);
    if (ast === undefined) return undefined;
    // Record a dep edge on constOf for every condition we inspect. Passing
    // `db.get(constOf, …)` directly inside the rewrite ensures the edge is
    // recorded on *this* query's cell (runtime's current-query stack).
    return rewriteDeadBranch(ast, (nodeId) => db.get(constOf, nodeId));
  },
});

export const astAfterConstFold: QueryHandle<
  number,
  StmtNS.FileInput | undefined
> = defineQuery<number, StmtNS.FileInput | undefined>({
  name: "astAfterConstFold",
  lattice: astLattice,
  serialize: String,
  fn: (db, unitId) => {
    const ast = db.get(astAfterDeadBranch, unitId);
    if (ast === undefined) return undefined;
    return rewriteConstantFold(ast, (nodeId) => db.get(constOf, nodeId));
  },
});

export const astAfterMemoize: QueryHandle<
  number,
  StmtNS.FileInput | undefined
> = defineQuery<number, StmtNS.FileInput | undefined>({
  name: "astAfterMemoize",
  lattice: astLattice,
  serialize: String,
  fn: (db, unitId) => {
    const ast = db.get(astAfterConstFold, unitId);
    if (ast === undefined) return undefined;
    return rewriteMemoize(ast, (scopeId) => db.get(shouldMemoize, scopeId));
  },
});

// Consumer-facing alias for the terminal lowering stage. Re-exporting the
// handle (rather than wrapping it in a new query) shares the underlying
// cell with astAfterMemoize — no extra dep edge, no extra recompute.
// Adding a further lowering stage only requires repointing this binding.
export const optimizedAstOf: QueryHandle<
  number,
  StmtNS.FileInput | undefined
> = astAfterMemoize;
