/**
 * Unit tests for AnalysisModule.observeValue + mergeIntoHint hooks.
 *
 * These hooks translate raw runtime values (e.g. tagged CSE stash values) into
 * lattice elements, then widen a HintStore entry via join.
 */

import { ConstAnalysisPass } from "../specialization/const-analysis/analysis";
import { TypeAnalysisPass } from "../specialization/type-analysis/analysis";
import {
  BOOL_BIT,
  INT_BIT,
  STR_BIT,
  CLOSURE_BIT,
  NULL_BIT,
  FLOAT_BIT,
} from "../specialization/type-analysis/lattice";
import { constOf, CONST_TOP } from "../specialization/const-analysis/lattice";

describe("TypeAnalysisPass.observeValue", () => {
  const m = new TypeAnalysisPass();

  test.each([
    ["raw number 42", 42, INT_BIT],
    ["raw number -7", -7, INT_BIT],
    ["raw number 0", 0, INT_BIT],
    ["raw number 3.14", 3.14, FLOAT_BIT],
    ["raw true", true, BOOL_BIT],
    ["raw false", false, BOOL_BIT],
    ["raw string", "hello", STR_BIT],
    ["raw null", null, NULL_BIT],
    ["raw undefined", undefined, NULL_BIT],
  ])("%s → correct kind bit", (_name, raw, expectedBit) => {
    const lattice = m.observeValue!(raw);
    expect(lattice).toBeDefined();
    expect(lattice!.kinds & expectedBit).toBeTruthy();
  });

  test.each([
    ["tagged number", { type: "number", value: 42 }, INT_BIT],
    ["tagged bool", { type: "bool", value: true }, BOOL_BIT],
    ["tagged string", { type: "string", value: "x" }, STR_BIT],
    ["tagged none", { type: "none" }, NULL_BIT],
    ["tagged closure", { type: "closure", closure: {} }, CLOSURE_BIT],
    ["tagged function", { type: "function" }, CLOSURE_BIT],
    ["tagged builtin", { type: "builtin" }, CLOSURE_BIT],
  ])("%s → correct kind bit", (_name, raw, expectedBit) => {
    const lattice = m.observeValue!(raw);
    expect(lattice).toBeDefined();
    expect(lattice!.kinds & expectedBit).toBeTruthy();
  });

  test("unknown shape returns undefined", () => {
    expect(m.observeValue!({ foo: "bar" })).toBeUndefined();
    expect(m.observeValue!(Symbol("x"))).toBeUndefined();
  });
});

describe("TypeAnalysisPass.mergeIntoHint", () => {
  const m = new TypeAnalysisPass();

  test("merges into empty hint", () => {
    const observed = m.observeValue!(42)!;
    const merged = m.mergeIntoHint!({}, observed);
    expect(merged.type).toBe(observed);
  });

  test("widens (join) when hint already has a type", () => {
    const intL = m.observeValue!(42)!;
    const strL = m.observeValue!("hello")!;
    const merged = m.mergeIntoHint!({ type: intL }, strL);
    // Widened to include both kinds
    expect(merged.type!.kinds & INT_BIT).toBeTruthy();
    expect(merged.type!.kinds & STR_BIT).toBeTruthy();
  });

  test("preserves other hint fields", () => {
    const intL = m.observeValue!(42)!;
    const merged = m.mergeIntoHint!({ constVal: constOf(42) }, intL);
    expect(merged.constVal).toEqual(constOf(42));
    expect(merged.type).toBeDefined();
  });
});

describe("ConstAnalysisPass.observeValue", () => {
  const m = new ConstAnalysisPass();

  test("primitive number → constOf", () => {
    expect(m.observeValue!(42)).toEqual(constOf(42));
  });

  test("primitive string → constOf", () => {
    expect(m.observeValue!("hello")).toEqual(constOf("hello"));
  });

  test("primitive bool → constOf", () => {
    expect(m.observeValue!(true)).toEqual(constOf(true));
  });

  test("tagged number → constOf", () => {
    expect(m.observeValue!({ type: "number", value: 42 })).toEqual(constOf(42));
  });

  test("non-primitive returns undefined (not CONST_TOP)", () => {
    // Critical: returning CONST_TOP here would erase existing constants on widening.
    expect(m.observeValue!({ type: "closure" })).toBeUndefined();
    expect(m.observeValue!({ type: "list", value: [] })).toBeUndefined();
    expect(m.observeValue!(null)).toBeUndefined();
  });
});

describe("ConstAnalysisPass.mergeIntoHint", () => {
  const m = new ConstAnalysisPass();

  test("merges into empty hint", () => {
    const merged = m.mergeIntoHint!({}, constOf(42));
    expect(merged.constVal).toEqual(constOf(42));
  });

  test("same value twice → unchanged", () => {
    const merged = m.mergeIntoHint!({ constVal: constOf(42) }, constOf(42));
    expect(merged.constVal).toEqual(constOf(42));
  });

  test("different values → widens to CONST_TOP", () => {
    const merged = m.mergeIntoHint!({ constVal: constOf(42) }, constOf(99));
    expect(merged.constVal).toEqual(CONST_TOP);
  });

  test("preserves other hint fields", () => {
    const merged = m.mergeIntoHint!({ type: undefined }, constOf(42));
    expect(merged.constVal).toEqual(constOf(42));
  });
});
