/**
 * Unit tests for AnalysisPass.observeWrite — the per-analysis reaction to a
 * runtime write. Lifts a raw value into the lattice and merges into the hint
 * in one step (join semantics; never narrows).
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

describe("TypeAnalysisPass.observeWrite", () => {
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
  ])("%s → correct kind bit on hint.type", (_name, raw, expectedBit) => {
    const merged = m.observeWrite!({}, raw);
    expect(merged.type).toBeDefined();
    expect(merged.type!.kinds & expectedBit).toBeTruthy();
  });

  test.each([
    ["tagged number", { type: "number", value: 42 }, INT_BIT],
    ["tagged bool", { type: "bool", value: true }, BOOL_BIT],
    ["tagged string", { type: "string", value: "x" }, STR_BIT],
    ["tagged none", { type: "none" }, NULL_BIT],
    ["tagged closure", { type: "closure", closure: {} }, CLOSURE_BIT],
    ["tagged function", { type: "function" }, CLOSURE_BIT],
    ["tagged builtin", { type: "builtin" }, CLOSURE_BIT],
  ])("%s → correct kind bit on hint.type", (_name, raw, expectedBit) => {
    const merged = m.observeWrite!({}, raw);
    expect(merged.type).toBeDefined();
    expect(merged.type!.kinds & expectedBit).toBeTruthy();
  });

  test("unknown shape leaves hint unchanged", () => {
    const base = { type: undefined };
    expect(m.observeWrite!(base, { foo: "bar" })).toBe(base);
    expect(m.observeWrite!(base, Symbol("x"))).toBe(base);
  });

  test("widens (join) when hint already has a type", () => {
    const afterInt = m.observeWrite!({}, 42);
    const afterBoth = m.observeWrite!(afterInt, "hello");
    expect(afterBoth.type!.kinds & INT_BIT).toBeTruthy();
    expect(afterBoth.type!.kinds & STR_BIT).toBeTruthy();
  });

  test("preserves other hint fields", () => {
    const merged = m.observeWrite!({ constVal: constOf(42) }, 42);
    expect(merged.constVal).toEqual(constOf(42));
    expect(merged.type).toBeDefined();
  });
});

describe("ConstAnalysisPass.observeWrite", () => {
  const m = new ConstAnalysisPass();

  test("primitive number → constVal set", () => {
    expect(m.observeWrite!({}, 42).constVal).toEqual(constOf(42));
  });

  test("primitive string → constVal set", () => {
    expect(m.observeWrite!({}, "hello").constVal).toEqual(constOf("hello"));
  });

  test("primitive bool → constVal set", () => {
    expect(m.observeWrite!({}, true).constVal).toEqual(constOf(true));
  });

  test("tagged number → constVal set", () => {
    expect(m.observeWrite!({}, { type: "number", value: 42 }).constVal).toEqual(constOf(42));
  });

  test("non-primitive leaves hint unchanged (does not widen to CONST_TOP)", () => {
    // Critical: widening to CONST_TOP would erase existing constants.
    const base = { constVal: constOf(42) };
    expect(m.observeWrite!(base, { type: "closure" })).toBe(base);
    expect(m.observeWrite!(base, { type: "list", value: [] })).toBe(base);
    expect(m.observeWrite!(base, null)).toBe(base);
  });

  test("same value twice → unchanged constVal", () => {
    const after = m.observeWrite!({ constVal: constOf(42) }, 42);
    expect(after.constVal).toEqual(constOf(42));
  });

  test("different values → widens to CONST_TOP", () => {
    const after = m.observeWrite!({ constVal: constOf(42) }, 99);
    expect(after.constVal).toEqual(CONST_TOP);
  });

  test("preserves other hint fields", () => {
    const after = m.observeWrite!({ type: undefined }, 42);
    expect(after.constVal).toEqual(constOf(42));
  });
});
