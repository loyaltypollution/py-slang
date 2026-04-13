/**
 * Unit tests for ConstLattice algebraic operations (leq/join/meet).
 *
 * End-to-end const-analysis behaviour (e.g. `x = 3 + 4 → const(7)`,
 * variable propagation, while-loop convergence) is covered in
 * `reactive-optimization.test.ts` via Worklist.
 */

import {
  constLeq,
  constJoin,
  constMeet,
  CONST_BOTTOM,
  CONST_TOP,
  constOf,
} from "../specialization";

describe("ConstLattice operations", () => {
  const c3 = constOf(3);
  const c7 = constOf(7);

  describe("constLeq", () => {
    test("bottom ≤ everything", () => {
      expect(constLeq(CONST_BOTTOM, CONST_BOTTOM)).toBe(true);
      expect(constLeq(CONST_BOTTOM, c3)).toBe(true);
      expect(constLeq(CONST_BOTTOM, CONST_TOP)).toBe(true);
    });
    test("everything ≤ top", () => {
      expect(constLeq(CONST_TOP, CONST_TOP)).toBe(true);
      expect(constLeq(c3, CONST_TOP)).toBe(true);
      expect(constLeq(CONST_BOTTOM, CONST_TOP)).toBe(true);
    });
    test("const(v) ≤ const(v) for same value", () => {
      expect(constLeq(c3, c3)).toBe(true);
      expect(constLeq(c3, constOf(3))).toBe(true);
    });
    test("const(v) ≰ const(w) for v ≠ w", () => {
      expect(constLeq(c3, c7)).toBe(false);
    });
    test("top ≰ bottom or const", () => {
      expect(constLeq(CONST_TOP, CONST_BOTTOM)).toBe(false);
      expect(constLeq(CONST_TOP, c3)).toBe(false);
    });
  });

  describe("constJoin (LUB)", () => {
    test("join(bottom, x) = x", () => {
      expect(constJoin(CONST_BOTTOM, c3)).toEqual(c3);
      expect(constJoin(CONST_BOTTOM, CONST_TOP)).toEqual(CONST_TOP);
      expect(constJoin(CONST_BOTTOM, CONST_BOTTOM)).toEqual(CONST_BOTTOM);
    });
    test("join(top, x) = top", () => {
      expect(constJoin(CONST_TOP, c3)).toEqual(CONST_TOP);
      expect(constJoin(c3, CONST_TOP)).toEqual(CONST_TOP);
    });
    test("join(const(v), const(v)) = const(v)", () => {
      expect(constJoin(c3, constOf(3))).toEqual(c3);
    });
    test("join(const(v), const(w)) = top when v ≠ w", () => {
      expect(constJoin(c3, c7)).toEqual(CONST_TOP);
    });
  });

  describe("constMeet (GLB)", () => {
    test("meet(top, x) = x", () => {
      expect(constMeet(CONST_TOP, c3)).toEqual(c3);
      expect(constMeet(c3, CONST_TOP)).toEqual(c3);
    });
    test("meet(bottom, x) = bottom", () => {
      expect(constMeet(CONST_BOTTOM, c3)).toEqual(CONST_BOTTOM);
      expect(constMeet(c3, CONST_BOTTOM)).toEqual(CONST_BOTTOM);
    });
    test("meet(const(v), const(v)) = const(v)", () => {
      expect(constMeet(c3, constOf(3))).toEqual(c3);
    });
    test("meet(const(v), const(w)) = bottom when v ≠ w", () => {
      expect(constMeet(c3, c7)).toEqual(CONST_BOTTOM);
    });
  });
});
