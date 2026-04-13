// src/specialization/runtime/queries/lowering.ts — Phase 4 lowering queries.
//
// Chain: { astOf, environmentsOf } → loweredAfterDeadBranch
//                                  → loweredAfterConstFold
//                                  → loweredAfterMemoize
//                                  ≡ optimizedLoweredOf
//
// Each stage reads the previous stage's LoweredUnit plus the relevant fact
// queries via `db.get`, and delegates the rewrite to the pure helpers in
// `../../transforms/pure-rewrites.ts`. The LoweredUnit carries both the AST
// and the FunctionEnvironments map extended for any synthesized scope nodes
// (currently only memoize-wrapped FunctionDefs); downstream consumers thus
// avoid re-running the resolver on the lowered AST.
//
// Early-cutoff invariant: every stage returns its input LoweredUnit
// reference unchanged when its rewrite has nothing to do. Combined with
// `equals: ===`, an unchanged stage snaps green without waking downstream
// dependents.
//
// Legacy AST-only queries (`astAfterDeadBranch`, `astAfterConstFold`,
// `astAfterMemoize`, `optimizedAstOf`) remain exported as thin projections
// so existing call sites that only want the AST keep working.

import { StmtNS } from "../../../ast-types";
import type { FunctionEnvironments } from "../../../resolver/resolver";
import {
  LoweredUnit,
  rewriteDeadBranch,
  rewriteConstantFold,
  rewriteMemoize,
} from "../../transforms/pure-rewrites";
import { astOf, environmentsOf } from "../inputs";
import type { Lattice } from "../lattice";
import { defineQuery, type QueryHandle } from "../query";
import { constOf } from "./const-of";
import { shouldMemoize } from "./scope";

type LoweredOrUndef = LoweredUnit | undefined;

const loweredLattice: Lattice<LoweredOrUndef> = {
  bottom: undefined,
  equals: (a, b) => a === b,
  join: (_a, b) => b,
};

// Assemble the base LoweredUnit from the two driver inputs.
const loweredUnitBase: QueryHandle<number, LoweredOrUndef> = defineQuery<
  number,
  LoweredOrUndef
>({
  name: "loweredUnitBase",
  lattice: loweredLattice,
  serialize: String,
  fn: (db, unitId) => {
    const ast = astOf.get(db, unitId);
    const environments = environmentsOf.get(db, unitId);
    if (ast === undefined || environments === undefined) return undefined;
    return { ast, environments };
  },
});

export const loweredAfterDeadBranch: QueryHandle<number, LoweredOrUndef> =
  defineQuery<number, LoweredOrUndef>({
    name: "loweredAfterDeadBranch",
    lattice: loweredLattice,
    serialize: String,
    fn: (db, unitId) => {
      const input = db.get(loweredUnitBase, unitId);
      if (input === undefined) return undefined;
      return rewriteDeadBranch(input, (nodeId) => db.get(constOf, nodeId));
    },
  });

export const loweredAfterConstFold: QueryHandle<number, LoweredOrUndef> =
  defineQuery<number, LoweredOrUndef>({
    name: "loweredAfterConstFold",
    lattice: loweredLattice,
    serialize: String,
    fn: (db, unitId) => {
      const input = db.get(loweredAfterDeadBranch, unitId);
      if (input === undefined) return undefined;
      return rewriteConstantFold(input, (nodeId) => db.get(constOf, nodeId));
    },
  });

export const loweredAfterMemoize: QueryHandle<number, LoweredOrUndef> =
  defineQuery<number, LoweredOrUndef>({
    name: "loweredAfterMemoize",
    lattice: loweredLattice,
    serialize: String,
    fn: (db, unitId) => {
      const input = db.get(loweredAfterConstFold, unitId);
      if (input === undefined) return undefined;
      return rewriteMemoize(input, (scopeId) => db.get(shouldMemoize, scopeId));
    },
  });

// Terminal alias. Re-exporting the handle shares the cell — no extra dep
// edge, no extra recompute.
export const optimizedLoweredOf: QueryHandle<number, LoweredOrUndef> =
  loweredAfterMemoize;

// ─────────────────────────────────────────────────────────────────────
// AST-only projections (backward compat for callers that don't need envs)
// ─────────────────────────────────────────────────────────────────────

const astLattice: Lattice<StmtNS.FileInput | undefined> = {
  bottom: undefined,
  equals: (a, b) => a === b,
  join: (_a, b) => b,
};

function astExtractor(stage: QueryHandle<number, LoweredOrUndef>, name: string) {
  return defineQuery<number, StmtNS.FileInput | undefined>({
    name,
    lattice: astLattice,
    serialize: String,
    fn: (db, unitId) => db.get(stage, unitId)?.ast,
  });
}

export const astAfterDeadBranch = astExtractor(
  loweredAfterDeadBranch,
  "astAfterDeadBranch",
);
export const astAfterConstFold = astExtractor(
  loweredAfterConstFold,
  "astAfterConstFold",
);
export const astAfterMemoize = astExtractor(
  loweredAfterMemoize,
  "astAfterMemoize",
);
export const optimizedAstOf: QueryHandle<
  number,
  StmtNS.FileInput | undefined
> = astAfterMemoize;

// Environments projection — the whole reason LoweredUnit exists. Consumers
// that need to compile the lowered AST read this to avoid re-resolving.
const environmentsLattice: Lattice<FunctionEnvironments | undefined> = {
  bottom: undefined,
  equals: (a, b) => a === b,
  join: (_a, b) => b,
};

export const optimizedEnvironmentsOf: QueryHandle<
  number,
  FunctionEnvironments | undefined
> = defineQuery<number, FunctionEnvironments | undefined>({
  name: "optimizedEnvironmentsOf",
  lattice: environmentsLattice,
  serialize: String,
  fn: (db, unitId) => db.get(optimizedLoweredOf, unitId)?.environments,
});
