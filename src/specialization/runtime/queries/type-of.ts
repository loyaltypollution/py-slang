// src/specialization/runtime/queries/type-of.ts — per-node TypeLattice query
//
// Strategy A per the Phase 3c+3d spec: reuse the per-unit `typeBlockEnvs`
// OUT map, locate the block containing the target node, reconstruct that
// block's IN env from predecessor OUTs, replay the block's transfer with a
// tap that captures `(nodeId → TypeLattice)`, and project the requested
// node. BOTTOM when the node isn't reached by any block's transfer (e.g.,
// statement-only nodes the visitor never annotates, or node ids that never
// appear in the program).

import type { BasicBlock, BlockId, CFG } from "../../framework/cfg";
import { MutableEnv } from "../../framework/mutable-env";
import { buildSlotTable, type SlotLookup } from "../../framework/slot-table";
import {
  BOTTOM,
  type TypeLattice,
  join as typeJoin,
  leq as typeLeq,
} from "../../type-analysis/lattice";
import { nodeTypeFactsForBlock } from "../../type-analysis/analysis";
import type { Db } from "../db";
import { astOf, environmentsOf, runtimeWrite } from "../inputs";
import type { Lattice } from "../lattice";
import { defineQuery, type QueryHandle } from "../query";
import { cfgOf } from "./cfg";
import { typeBlockEnvs } from "./block-envs";

// Unit 0 — the sole parsed unit per evaluator invocation; matches block-envs.
const UNIT_ID = 0;

const typeLatticeAdapter: Lattice<TypeLattice> = {
  bottom: BOTTOM,
  // TypeLattice shape is a flat record of numeric bit/ref fields; structural
  // equality via mutual leq is correct and cheap.
  equals: (a, b) => typeLeq(a, b) && typeLeq(b, a),
  join: typeJoin,
};

// Walk stmt subtree and collect numeric `.id` fields. Mirrors
// `function-unit.populateBlockOfNode` reflection; duplicated locally to
// avoid depending on the legacy framework layer from runtime/queries.
function collectIdsIn(stmt: unknown, out: Set<number>): void {
  const seen = new WeakSet<object>();
  const walk = (node: unknown): void => {
    if (node === null || typeof node !== "object") return;
    if (seen.has(node as object)) return;
    seen.add(node as object);
    const obj = node as Record<string, unknown>;
    const id = obj.id;
    if (typeof id === "number") out.add(id);
    for (const key of Object.keys(obj)) {
      const child = obj[key];
      if (Array.isArray(child)) for (const item of child) walk(item);
      else if (typeof child === "object" && child !== null) walk(child);
    }
  };
  walk(stmt);
}

function findBlockByNodeId(cfg: CFG, nodeId: number): BasicBlock | undefined {
  for (const block of cfg.blocks) {
    const ids = new Set<number>();
    for (const stmt of block.stmts) collectIdsIn(stmt, ids);
    if (ids.has(nodeId)) return block;
  }
  return undefined;
}

// Pulls every reachable node id across the CFG so we can (a) preregister
// dep edges on `runtimeWrite` — the same mechanism `typeBlockEnvs` uses to
// invalidate on observations — and (b) seed the replay's observation map.
function collectAllIds(cfg: CFG): number[] {
  const ids = new Set<number>();
  for (const block of cfg.blocks) for (const stmt of block.stmts) collectIdsIn(stmt, ids);
  return [...ids].sort((a, b) => a - b);
}

function gatherObservations(
  db: Db,
  nodeIds: readonly number[],
): ReadonlyMap<number, unknown> {
  const out = new Map<number, unknown>();
  for (const id of nodeIds) {
    const obs = runtimeWrite.get(db, id);
    if (obs !== undefined) out.set(id, obs);
  }
  return out;
}

function slotLookupFor(db: Db): SlotLookup {
  const ast = astOf.get(db, UNIT_ID);
  if (ast === undefined) throw new Error(`typeOf: no AST for unit ${UNIT_ID}`);
  const envs = environmentsOf.get(db, UNIT_ID);
  if (envs === undefined) {
    throw new Error(`typeOf: no FunctionEnvironments for unit ${UNIT_ID}`);
  }
  const scopeEnv = envs.get(ast);
  if (scopeEnv === undefined) {
    throw new Error(`typeOf: no scope env for top-level FileInput`);
  }
  return buildSlotTable(scopeEnv, []);
}

function blockInEnv(
  block: BasicBlock,
  cfg: CFG,
  outEnvs: ReadonlyMap<BlockId, MutableEnv<TypeLattice>>,
): MutableEnv<TypeLattice> {
  if (block === cfg.entry) return new MutableEnv<TypeLattice>();
  let merged = new MutableEnv<TypeLattice>();
  for (const pred of block.predecessors) {
    const predOut = outEnvs.get(pred.id);
    if (predOut === undefined) continue;
    merged.joinWith(predOut, typeJoin);
  }
  return merged;
}

export const typeOf: QueryHandle<number, TypeLattice> = defineQuery<
  number,
  TypeLattice
>({
  name: "typeOf",
  lattice: typeLatticeAdapter,
  serialize: String,
  fn: (db, nodeId) => {
    const cfg = db.get(cfgOf, UNIT_ID);
    if (cfg === undefined) return BOTTOM;
    const block = findBlockByNodeId(cfg, nodeId);
    if (block === undefined) return BOTTOM;

    // Reading typeBlockEnvs registers a dep so changes to the DFA result
    // invalidate this cell; also ensures observations (via gatherObservations
    // there) are reflected. We still must re-pull observations here since
    // the replay consumes them directly.
    const outEnvs = db.get(typeBlockEnvs, UNIT_ID);
    const slotLookup = slotLookupFor(db);
    const allIds = collectAllIds(cfg);
    const observations = gatherObservations(db, allIds);

    const inEnv = blockInEnv(block, cfg, outEnvs);
    const facts = nodeTypeFactsForBlock(block, inEnv, slotLookup, observations);
    return facts.get(nodeId) ?? BOTTOM;
  },
});
