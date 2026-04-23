import { MutableEnv } from "../../../specialization/framework/mutable-env";
import {
  BOUND,
  UNBOUND,
  boundLattice,
  type BoundStatus,
} from "../../../specialization/definitely-bound-analysis/lattice";
import {
  BOTTOM,
  INT_POS,
  TOP,
  eq,
  join,
  leq,
  meet,
} from "../../../specialization/type-analysis/lattice";

describe("must-analysis env mechanics", () => {
  const typeLattice = { bottom: BOTTOM, top: TOP, join, meet, leq, eq };

  test("MutableEnv.meetWith treats an absent slot as top for sparse must envs", () => {
    const reqs = new MutableEnv<typeof INT_POS>();
    reqs.set(0, INT_POS);

    const noConstraint = new MutableEnv<typeof INT_POS>();
    reqs.meetWith(noConstraint, typeLattice);

    expect(reqs.get(0)).toEqual(INT_POS);
  });

  test("definitely-bound stays pessimistic because both sides carry explicit slot values", () => {
    const lhs = new MutableEnv<BoundStatus>();
    lhs.set(0, UNBOUND);

    const rhs = new MutableEnv<BoundStatus>();
    rhs.set(0, BOUND);

    lhs.meetWith(rhs, boundLattice);
    expect(lhs.get(0)).toBe(UNBOUND);
  });
});
