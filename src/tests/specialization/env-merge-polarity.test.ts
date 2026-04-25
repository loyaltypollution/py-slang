import { MutableEnv } from "../../specialization/analysis/mutable-env";
import {
  BOUND,
  UNBOUND,
  boundLattice,
  type BoundStatus,
} from "../../specialization/analysis/definitely-bound/lattice";
import {
  BOTTOM,
  INT_NEG,
  INT_POS,
  TOP,
  eq,
  join,
  leq,
  meet,
} from "../../specialization/analysis/type/lattice";

const typeLattice = { bottom: BOTTOM, top: TOP, join, meet, leq, eq };

describe("MutableEnv merge polarity", () => {
  describe("must (meetWith)", () => {
    test("absent slot on the other side is treated as top", () => {
      const reqs = new MutableEnv<typeof INT_POS>();
      reqs.set(0, INT_POS);
      reqs.meetWith(new MutableEnv(), typeLattice);
      expect(reqs.get(0)).toEqual(INT_POS);
    });

    test("pessimistic: explicit bindings combine via lattice meet", () => {
      const lhs = new MutableEnv<BoundStatus>();
      lhs.set(0, UNBOUND);
      const rhs = new MutableEnv<BoundStatus>();
      rhs.set(0, BOUND);
      lhs.meetWith(rhs, boundLattice);
      expect(lhs.get(0)).toBe(UNBOUND);
    });
  });

  describe("may (joinWith)", () => {
    test("absent slot on the other side leaves the existing binding intact", () => {
      const env = new MutableEnv<typeof INT_POS>();
      env.set(0, INT_POS);
      env.joinWith(new MutableEnv(), typeLattice);
      expect(env.get(0)).toEqual(INT_POS);
    });

    test("absent slot on this side adopts the other side's binding", () => {
      const env = new MutableEnv<typeof INT_POS>();
      const other = new MutableEnv<typeof INT_POS>();
      other.set(0, INT_POS);
      env.joinWith(other, typeLattice);
      expect(env.get(0)).toEqual(INT_POS);
    });

    test("optimistic: explicit bindings combine via lattice join", () => {
      const lhs = new MutableEnv<typeof INT_POS>();
      lhs.set(0, INT_NEG);
      const rhs = new MutableEnv<typeof INT_POS>();
      rhs.set(0, INT_POS);
      lhs.joinWith(rhs, typeLattice);
      expect(eq(lhs.get(0)!, join(INT_NEG, INT_POS))).toBe(true);
    });
  });
});
