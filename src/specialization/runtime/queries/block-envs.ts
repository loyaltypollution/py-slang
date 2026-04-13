// src/specialization/runtime/queries/block-envs.ts — per-unit DFA fixpoint queries
//
// Per-block `blockOut` as a self-recursive query is the shape the
// architecture plan names, but our Phase 1 runtime's `cycle_fn` only
// resolves single-cell recursion, not multi-block SCCs. Decision
// (DECISIONS.md §Phase 3): model the whole DFA as a single query per
// (unit, analysis), returning `ReadonlyMap<BlockId, Env>`. Per-node queries
// (Phase 3c+) project from this map.

import type { BlockId, CFG } from "../../framework/cfg";
import { MutableEnv } from "../../framework/mutable-env";
import { buildSlotTable, type SlotLookup } from "../../framework/slot-table";
import {
  type ConstLattice,
  constJoin,
  constLeq,
} from "../../const-analysis/lattice";
import { transferBlockPureConst } from "../../const-analysis/analysis";
import {
  type TypeLattice,
  join as typeJoin,
  leq as typeLeq,
} from "../../type-analysis/lattice";
import { transferBlockPureType } from "../../type-analysis/analysis";
import type { Db } from "../db";
import { astOf, environmentsOf, runtimeWrite } from "../inputs";
import type { Lattice } from "../lattice";
import { defineQuery, type QueryHandle } from "../query";
import { cfgOf } from "./cfg";
import { kildall } from "./kildall";

// ── Env-level lattice helper ─────────────────────────────────────────────

// Bottom is a fresh empty env; equality uses the per-element leq both ways
// (via `MutableEnv.equals`). Join mutates a snapshot of `a` so the input
// isn't shared with downstream cells.
function envLattice<L>(
  elemLeq: (a: L, b: L) => boolean,
  elemJoin: (a: L, b: L) => L,
): Lattice<MutableEnv<L>> {
  return {
    bottom: new MutableEnv<L>(),
    equals: (a, b) => a.equals(b, elemLeq),
    join: (a, b) => {
      const merged = a.snapshot();
      merged.joinWith(b, elemJoin);
      return merged;
    },
  };
}

// ── Per-block-env map lattice ────────────────────────────────────────────

// Early cutoff fires when the full per-block map is pointwise env-equal
// across recomputes. Fresh Map reference is returned from each recompute,
// so reference equality alone would never early-cutoff.
function mapLattice<L>(
  envL: Lattice<MutableEnv<L>>,
): Lattice<ReadonlyMap<BlockId, MutableEnv<L>>> {
  return {
    bottom: new Map<BlockId, MutableEnv<L>>(),
    equals: (a, b) => {
      if (a === b) return true;
      if (a.size !== b.size) return false;
      for (const [k, va] of a) {
        const vb = b.get(k);
        if (vb === undefined) return false;
        if (!envL.equals(va, vb)) return false;
      }
      return true;
    },
    join: (a, b) => {
      const out = new Map<BlockId, MutableEnv<L>>();
      for (const [k, v] of a) out.set(k, v);
      for (const [k, v] of b) {
        const prev = out.get(k);
        out.set(k, prev === undefined ? v : envL.join(prev, v));
      }
      return out;
    },
  };
}

// ── Query-body scaffolding ───────────────────────────────────────────────

// Walk every AST node reachable from block statements and collect numeric
// `.id` fields. Mirrors the reflection approach used by
// `function-unit.populateBlockOfNode`. Used to pre-register dep edges on
// `runtimeWrite` inputs so an observation on any reachable node
// invalidates the DFA.
function collectNodeIds(cfg: CFG): number[] {
  const ids = new Set<number>();
  const seen = new WeakSet<object>();
  const walk = (node: unknown): void => {
    if (node === null || typeof node !== "object") return;
    if (seen.has(node as object)) return;
    seen.add(node as object);
    const obj = node as Record<string, unknown>;
    const id = obj.id;
    if (typeof id === "number") ids.add(id);
    for (const key of Object.keys(obj)) {
      const child = obj[key];
      if (Array.isArray(child)) for (const item of child) walk(item);
      else if (typeof child === "object" && child !== null) walk(child);
    }
  };
  for (const block of cfg.blocks) for (const stmt of block.stmts) walk(stmt);
  return [...ids].sort((a, b) => a - b);
}

function slotLookupForUnit(db: Db, unitId: number): SlotLookup {
  const ast = astOf.get(db, unitId);
  if (ast === undefined) {
    throw new Error(`block-envs(${unitId}): no AST set`);
  }
  const envs = environmentsOf.get(db, unitId);
  if (envs === undefined) {
    throw new Error(
      `block-envs(${unitId}): no FunctionEnvironments set — call environmentsOf.set(db, ${unitId}, resolver.functionEnvironments)`,
    );
  }
  const scopeEnv = envs.get(ast);
  if (scopeEnv === undefined) {
    throw new Error(
      `block-envs(${unitId}): FunctionEnvironments has no entry for the top-level FileInput`,
    );
  }
  // Top-level FileInput scope has no parameters.
  return buildSlotTable(scopeEnv, []);
}

function gatherObservations(
  db: Db,
  nodeIds: readonly number[],
): ReadonlyMap<number, unknown> {
  const out = new Map<number, unknown>();
  for (const id of nodeIds) {
    // Every read registers a dep edge on `runtimeWrite@id`; that's how a
    // runtime observation invalidates this query. `undefined` (lattice
    // bottom) means "no observation" and is dropped from the observations
    // map so the legacy `tryRead` path sees "absent" rather than "widened
    // to undefined."
    const obs = runtimeWrite.get(db, id);
    if (obs !== undefined) out.set(id, obs);
  }
  return out;
}

// ── typeBlockEnvs ────────────────────────────────────────────────────────

const typeEnvLattice = envLattice<TypeLattice>(typeLeq, typeJoin);
const typeBlockEnvsLattice = mapLattice<TypeLattice>(typeEnvLattice);

export const typeBlockEnvs: QueryHandle<
  number,
  ReadonlyMap<BlockId, MutableEnv<TypeLattice>>
> = defineQuery<number, ReadonlyMap<BlockId, MutableEnv<TypeLattice>>>({
  name: "typeBlockEnvs",
  lattice: typeBlockEnvsLattice,
  serialize: String,
  fn: (db, unitId) => {
    const cfg = db.get(cfgOf, unitId);
    if (cfg === undefined) {
      throw new Error(`typeBlockEnvs(${unitId}): cfg undefined`);
    }
    const slotLookup = slotLookupForUnit(db, unitId);
    const nodeIds = collectNodeIds(cfg);
    const observations = gatherObservations(db, nodeIds);
    const initial = new MutableEnv<TypeLattice>();
    return kildall<TypeLattice>(
      cfg,
      typeEnvLattice,
      initial,
      (env, block) => transferBlockPureType(block, env, slotLookup, observations),
    );
  },
});

// ── constBlockEnvs ───────────────────────────────────────────────────────

const constEnvLattice = envLattice<ConstLattice>(constLeq, constJoin);
const constBlockEnvsLattice = mapLattice<ConstLattice>(constEnvLattice);

export const constBlockEnvs: QueryHandle<
  number,
  ReadonlyMap<BlockId, MutableEnv<ConstLattice>>
> = defineQuery<number, ReadonlyMap<BlockId, MutableEnv<ConstLattice>>>({
  name: "constBlockEnvs",
  lattice: constBlockEnvsLattice,
  serialize: String,
  fn: (db, unitId) => {
    const cfg = db.get(cfgOf, unitId);
    if (cfg === undefined) {
      throw new Error(`constBlockEnvs(${unitId}): cfg undefined`);
    }
    const slotLookup = slotLookupForUnit(db, unitId);
    const nodeIds = collectNodeIds(cfg);
    const observations = gatherObservations(db, nodeIds);
    const initial = new MutableEnv<ConstLattice>();
    return kildall<ConstLattice>(
      cfg,
      constEnvLattice,
      initial,
      (env, block) => transferBlockPureConst(block, env, slotLookup, observations),
    );
  },
});
