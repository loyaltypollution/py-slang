// src/specialization/runtime/queries/node-projection.ts
//
// Shared scaffolding for the per-node projection queries (`typeOf`,
// `constOf`). Both queries follow the same shape: locate the block
// containing the target node, reconstruct its IN env from predecessor
// OUTs, replay the block's transfer with a tap that captures
// `(nodeId → L)`, and project the requested node.
//
// Helpers here are lattice-agnostic and have no Db imports beyond what
// the call sites need to declare deps explicitly.

import type { BasicBlock, BlockId, CFG } from "../../framework/cfg";
import { MutableEnv } from "../../framework/mutable-env";
import { buildSlotTable, type SlotLookup } from "../../framework/slot-table";
import type { Db } from "../db";
import { astOf, environmentsOf, runtimeWrite } from "../inputs";

// Walk every AST node reachable from block statements and collect numeric
// `.id` fields. Mirrors `function-unit.populateBlockOfNode`'s reflection.
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

// Last-writer-wins: matches legacy `populateBlockOfNode` semantics. A
// control-flow header stmt (If/While/For) reaches its body stmts via
// `.body`/`.elseBlock` — but those body stmts are owned by successor
// blocks whose `.stmts` also contain them. Iterating in CFG order and
// keeping the latest match attributes each node id to its innermost block.
export function findBlockByNodeId(cfg: CFG, nodeId: number): BasicBlock | undefined {
  let found: BasicBlock | undefined;
  for (const block of cfg.blocks) {
    const ids = new Set<number>();
    for (const stmt of block.stmts) collectIdsIn(stmt, ids);
    if (ids.has(nodeId)) found = block;
  }
  return found;
}

export function collectAllIds(cfg: CFG): number[] {
  const ids = new Set<number>();
  for (const block of cfg.blocks) for (const stmt of block.stmts) collectIdsIn(stmt, ids);
  return [...ids].sort((a, b) => a - b);
}

// Every read registers a dep edge on `runtimeWrite@id`; that's how a
// runtime observation invalidates the calling query. `undefined` (lattice
// bottom) means "no observation" and is dropped so the transfer's tryRead
// path sees "absent" rather than "widened to undefined."
export function gatherObservations(
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

export function slotLookupForUnit(db: Db, unitId: number, queryName: string): SlotLookup {
  const ast = astOf.get(db, unitId);
  if (ast === undefined) throw new Error(`${queryName}: no AST for unit ${unitId}`);
  const envs = environmentsOf.get(db, unitId);
  if (envs === undefined) {
    throw new Error(`${queryName}: no FunctionEnvironments for unit ${unitId}`);
  }
  const scopeEnv = envs.get(ast);
  if (scopeEnv === undefined) {
    throw new Error(`${queryName}: no scope env for top-level FileInput`);
  }
  return buildSlotTable(scopeEnv, []);
}

export function blockInEnv<L>(
  block: BasicBlock,
  cfg: CFG,
  outEnvs: ReadonlyMap<BlockId, MutableEnv<L>>,
  elemJoin: (a: L, b: L) => L,
): MutableEnv<L> {
  if (block === cfg.entry) return new MutableEnv<L>();
  const merged = new MutableEnv<L>();
  for (const pred of block.predecessors) {
    const predOut = outEnvs.get(pred.id);
    if (predOut === undefined) continue;
    merged.joinWith(predOut, elemJoin);
  }
  return merged;
}
