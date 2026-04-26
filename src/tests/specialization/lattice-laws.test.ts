import {
  constEq,
  constJoin,
  constLeq,
  CONST_BOTTOM,
  CONST_TOP,
  constOf,
} from "../../specialization/analysis/const/lattice";
import {
  type AbsVal,
  absJoin,
  absLeq,
  BOTTOM as ABS_BOTTOM,
  GLOBAL as ABS_GLOBAL,
  IMPURE_MARKER,
  UNKNOWN as ABS_UNKNOWN,
} from "../../specialization/analysis/purity/lattice";
import { rawValueJoinSemiLattice } from "../../specialization/observation/runtime-analyses";
import type { RawKind } from "../../specialization/observation/raw-value";
import {
  BOOL_FALSE,
  BOOL_TRUE,
  BOTTOM,
  CLOSURE,
  COMPLEX,
  eq,
  FLOAT_NEG,
  FLOAT_POS,
  FLOAT_ZERO,
  integer,
  INT_NEG,
  INT_POS,
  INT_ZERO,
  join,
  leq,
  meet,
  NULL,
  STRING,
  TOP,
  type TypeLattice,
} from "../../specialization/analysis/type/lattice";
import { expectLatticeLaws, expectJoinSemiLatticeLaws } from "./harness/lattice-laws";

describe("reusable lattice-law verification", () => {
  test("TypeLattice satisfies bounded-lattice laws on a representative slice", () => {
    const values: TypeLattice[] = [
      BOTTOM,
      TOP,
      STRING,
      NULL,
      CLOSURE,
      COMPLEX,
      INT_NEG,
      INT_ZERO,
      INT_POS,
      integer(),
      BOOL_TRUE,
      BOOL_FALSE,
      FLOAT_NEG,
      FLOAT_ZERO,
      FLOAT_POS,
      join(INT_POS, BOOL_TRUE),
      join(INT_ZERO, NULL),
      join(STRING, CLOSURE),
      join(integer(), FLOAT_ZERO),
      join(join(INT_NEG, STRING), BOOL_FALSE),
    ];

    expectLatticeLaws(
      {
        bottom: BOTTOM,
        top: TOP,
        leq,
        join,
        meet,
        eq,
      },
      {
        values,
        describeValue: value =>
          `k=${value.kinds};i=${value.intRef};b=${value.boolRef};f=${value.floatRef}`,
      },
    );
  });

  test("ConstLattice satisfies lattice laws for a representative finite slice", () => {
    expectJoinSemiLatticeLaws(
      {
        bottom: CONST_BOTTOM,
        leq: constLeq,
        join: constJoin,
        eq: constEq,
      },
      {
        values: [CONST_BOTTOM, CONST_TOP, constOf(0), constOf(1), constOf(-1), constOf(42)],
        describeValue: value =>
          value.tag === "const" ? `const(${String(value.value)})` : value.tag,
      },
    );
  });

  test("runtime raw-kind observation lattices satisfy lattice laws", () => {
    const rawValues: RawKind[] = [
      { kind: "unknown" },
      { kind: "number", value: 1 },
      { kind: "number", value: 2 },
      { kind: "bool", value: true },
      { kind: "bool", value: false },
      { kind: "string", value: "x" },
      { kind: "string", value: "y" },
      { kind: "none" },
      { kind: "closure" },
      { kind: "complex" },
    ];

    expectJoinSemiLatticeLaws(rawValueJoinSemiLattice, {
      values: rawValues,
      describeValue: value => JSON.stringify(value),
    });
    expectJoinSemiLatticeLaws(rawValueJoinSemiLattice, {
      values: rawValues,
      describeValue: value => JSON.stringify(value),
    });
  });

  test("purity AbsVal satisfies lattice laws with IMPURE as top", () => {
    const values: AbsVal[] = [
      ABS_BOTTOM,
      ABS_UNKNOWN,
      IMPURE_MARKER,
      ABS_GLOBAL,
      { kind: "fresh", origin: 1 },
      { kind: "fresh", origin: 2 },
      { kind: "param", slot: 0 },
      { kind: "param", slot: 1 },
      { kind: "closure", functionId: 1, pure: undefined },
      { kind: "closure", functionId: 1, pure: true },
      { kind: "closure", functionId: 1, pure: false },
      { kind: "closure", functionId: 2, pure: true },
    ];

    expectJoinSemiLatticeLaws(
      {
        bottom: ABS_BOTTOM,
        leq: absLeq,
        join: absJoin,
        eq: (a, b) => a === b || (absLeq(a, b) && absLeq(b, a)),
      },
      {
        values,
        describeValue: value => {
          switch (value.kind) {
            case "fresh":
              return `fresh(${value.origin})`;
            case "param":
              return `param(${value.slot})`;
            case "closure":
              return `closure(${value.functionId},${String(value.pure)})`;
            default:
              return value.kind;
          }
        },
      },
    );
  });
});
