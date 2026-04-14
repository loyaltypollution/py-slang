/**
 * Unit tests for ConstLattice algebraic operations exposed via the public API.
 *
 * `constJoin` is the only standalone exported function; `leq`/`meet`/`top`/
 * `bottom` are accessed via `constAnalysisModule` (which conforms to
 * `BoundedLattice<ConstLattice>`).
 *
 * End-to-end const-analysis behaviour (e.g. `x = 3 + 4 → const(7)`,
 * variable propagation, while-loop convergence) is covered in
 * `reactive-optimization.test.ts` via Worklist.
 */

import { constAnalysisModule } from "../../../specialization/const-analysis/analysis";
import {
  CONST_TOP,
  constJoin,
  constOf,
} from "../../../specialization/const-analysis/lattice";

describe("ConstLattice operations", () => {
  const CONST_BOTTOM = constAnalysisModule.bottom;
  const c3 = constOf(3);
  const c7 = constOf(7);

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

  describe("module-level leq (via constAnalysisModule)", () => {
    const { leq } = constAnalysisModule;
    test("bottom ≤ everything", () => {
      expect(leq(CONST_BOTTOM, CONST_BOTTOM)).toBe(true);
      expect(leq(CONST_BOTTOM, c3)).toBe(true);
      expect(leq(CONST_BOTTOM, CONST_TOP)).toBe(true);
    });
    test("everything ≤ top", () => {
      expect(leq(CONST_TOP, CONST_TOP)).toBe(true);
      expect(leq(c3, CONST_TOP)).toBe(true);
    });
    test("const(v) ≤ const(v) iff same value", () => {
      expect(leq(c3, constOf(3))).toBe(true);
      expect(leq(c3, c7)).toBe(false);
    });
    test("top ≰ bottom or const", () => {
      expect(leq(CONST_TOP, CONST_BOTTOM)).toBe(false);
      expect(leq(CONST_TOP, c3)).toBe(false);
    });
  });

  describe("module-level meet (via constAnalysisModule)", () => {
    const { meet } = constAnalysisModule;
    test("meet(top, x) = x", () => {
      expect(meet(CONST_TOP, c3)).toEqual(c3);
      expect(meet(c3, CONST_TOP)).toEqual(c3);
    });
    test("meet(bottom, x) = bottom", () => {
      expect(meet(CONST_BOTTOM, c3)).toEqual(CONST_BOTTOM);
      expect(meet(c3, CONST_BOTTOM)).toEqual(CONST_BOTTOM);
    });
    test("meet(const(v), const(v)) = const(v)", () => {
      expect(meet(c3, constOf(3))).toEqual(c3);
    });
    test("meet(const(v), const(w)) = bottom when v ≠ w", () => {
      expect(meet(c3, c7)).toEqual(CONST_BOTTOM);
    });
  });
});
