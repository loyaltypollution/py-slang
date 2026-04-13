// src/specialization/runtime/queries/const-of.ts — per-node ConstLattice query
//
// Mirror of `type-of.ts` for the constant-propagation lattice. See the
// sibling file's header for the strategy (locate block → reconstruct IN env
// → replay with tap → project).

import type { BasicBlock, BlockId, CFG } from "../../framework/cfg";
import { MutableEnv } from "../../framework/mutable-env";
import { buildSlotTable, type SlotLookup } from "../../framework/slot-table";
import {
  CONST_BOTTOM,
  type ConstLattice,
  constJoin,
  constLeq,
} from "../../const-analysis/lattice";
import { nodeConstFactsForBlock } from "../../const-analysis/analysis";
import type { Db } from "../db";
import { astOf, environmentsOf, runtimeWrite } from "../inputs";
import type { Lattice } from "../lattice";
import { defineQuery, type QueryHandle } from "../query";
import { cfgOf } from "./cfg";
import { constBlockEnvs } from "./block-envs";

const UNIT_ID = 0;

const constLatticeAdapter: Lattice<ConstLattice> = {
  bottom: CONST_BOTTOM,
  equals: (a, b) => constLeq(a, b) && constLeq(b, a),
  join: constJoin,
};

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
  // Last-writer-wins: matches legacy `populateBlockOfNode`. Control-flow
  // headers (If/While/For) reach their body stmts via `.body`/`.elseBlock`,
  // but those stmts are owned by successor blocks whose `.stmts` also
  // contain them. Iterating in CFG order with last-match keeps the node
  // attribution at its innermost block.
  let found: BasicBlock | undefined;
  for (const block of cfg.blocks) {
    const ids = new Set<number>();
    for (const stmt of block.stmts) collectIdsIn(stmt, ids);
    if (ids.has(nodeId)) found = block;
  }
  return found;
}

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
  if (ast === undefined) throw new Error(`constOf: no AST for unit ${UNIT_ID}`);
  const envs = environmentsOf.get(db, UNIT_ID);
  if (envs === undefined) {
    throw new Error(`constOf: no FunctionEnvironments for unit ${UNIT_ID}`);
  }
  const scopeEnv = envs.get(ast);
  if (scopeEnv === undefined) {
    throw new Error(`constOf: no scope env for top-level FileInput`);
  }
  return buildSlotTable(scopeEnv, []);
}

function blockInEnv(
  block: BasicBlock,
  cfg: CFG,
  outEnvs: ReadonlyMap<BlockId, MutableEnv<ConstLattice>>,
): MutableEnv<ConstLattice> {
  if (block === cfg.entry) return new MutableEnv<ConstLattice>();
  const merged = new MutableEnv<ConstLattice>();
  for (const pred of block.predecessors) {
    const predOut = outEnvs.get(pred.id);
    if (predOut === undefined) continue;
    merged.joinWith(predOut, constJoin);
  }
  return merged;
}

export const constOf: QueryHandle<number, ConstLattice> = defineQuery<
  number,
  ConstLattice
>({
  name: "constOf",
  lattice: constLatticeAdapter,
  serialize: String,
  fn: (db, nodeId) => {
    const cfg = db.get(cfgOf, UNIT_ID);
    if (cfg === undefined) return CONST_BOTTOM;
    const block = findBlockByNodeId(cfg, nodeId);
    if (block === undefined) return CONST_BOTTOM;

    const outEnvs = db.get(constBlockEnvs, UNIT_ID);
    const slotLookup = slotLookupFor(db);
    const allIds = collectAllIds(cfg);
    const observations = gatherObservations(db, allIds);

    const inEnv = blockInEnv(block, cfg, outEnvs);
    const facts = nodeConstFactsForBlock(block, inEnv, slotLookup, observations);
    return facts.get(nodeId) ?? CONST_BOTTOM;
  },
});
