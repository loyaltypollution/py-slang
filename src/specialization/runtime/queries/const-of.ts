// src/specialization/runtime/queries/const-of.ts — per-node ConstLattice query
//
// Mirror of `type-of.ts` for the constant-propagation lattice. Shared
// scaffolding lives in `./node-projection`.

import {
  CONST_BOTTOM,
  type ConstLattice,
  constJoin,
  constLeq,
} from "../../const-analysis/lattice";
import { nodeConstFactsForBlock } from "../../const-analysis/analysis";
import type { Lattice } from "../lattice";
import { defineQuery, type QueryHandle } from "../query";
import { cfgOf } from "./cfg";
import { constBlockEnvs } from "./block-envs";
import {
  blockInEnv,
  collectAllIds,
  findBlockByNodeId,
  gatherObservations,
  slotLookupForUnit,
} from "./node-projection";

const UNIT_ID = 0;

const constLatticeAdapter: Lattice<ConstLattice> = {
  bottom: CONST_BOTTOM,
  equals: (a, b) => constLeq(a, b) && constLeq(b, a),
  join: constJoin,
};

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
    const slotLookup = slotLookupForUnit(db, UNIT_ID, "constOf");
    const observations = gatherObservations(db, collectAllIds(cfg));

    const inEnv = blockInEnv(block, cfg, outEnvs, constJoin);
    const facts = nodeConstFactsForBlock(block, inEnv, slotLookup, observations);
    return facts.get(nodeId) ?? CONST_BOTTOM;
  },
});
