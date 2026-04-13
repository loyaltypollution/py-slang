// src/specialization/runtime/queries/type-of.ts — per-node TypeLattice query
//
// Strategy A per the Phase 3c+3d spec: reuse the per-unit `typeBlockEnvs`
// OUT map, locate the block containing the target node, reconstruct that
// block's IN env from predecessor OUTs, replay the block's transfer with a
// tap that captures `(nodeId → TypeLattice)`, and project the requested
// node. Shared scaffolding lives in `./node-projection`.

import {
  BOTTOM,
  type TypeLattice,
  join as typeJoin,
  leq as typeLeq,
} from "../../type-analysis/lattice";
import { nodeTypeFactsForBlock } from "../../type-analysis/analysis";
import type { Lattice } from "../lattice";
import { defineQuery, type QueryHandle } from "../query";
import { cfgOf } from "./cfg";
import { typeBlockEnvs } from "./block-envs";
import {
  blockInEnv,
  collectAllIds,
  findBlockByNodeId,
  gatherObservations,
  slotLookupForUnit,
} from "./node-projection";

const UNIT_ID = 0;

const typeLatticeAdapter: Lattice<TypeLattice> = {
  bottom: BOTTOM,
  // Structural equality via mutual leq is correct and cheap for the flat
  // record of numeric bit/ref fields.
  equals: (a, b) => typeLeq(a, b) && typeLeq(b, a),
  join: typeJoin,
};

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

    // Reading typeBlockEnvs registers a dep so DFA changes invalidate
    // this cell; observations are re-pulled here since the replay
    // consumes them directly.
    const outEnvs = db.get(typeBlockEnvs, UNIT_ID);
    const slotLookup = slotLookupForUnit(db, UNIT_ID, "typeOf");
    const observations = gatherObservations(db, collectAllIds(cfg));

    const inEnv = blockInEnv(block, cfg, outEnvs, typeJoin);
    const facts = nodeTypeFactsForBlock(block, inEnv, slotLookup, observations);
    return facts.get(nodeId) ?? BOTTOM;
  },
});
