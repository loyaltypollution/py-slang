/**
 * Unit tests for AnalysisPass.observeWrite — the per-analysis reaction to a
 * runtime write. Lifts a raw value into the lattice and merges into the
 * corresponding fact cell in one step (join semantics; never narrows).
 */

import { ConstAnalysisPass } from "../specialization/const-analysis/analysis";
import { TypeAnalysisPass } from "../specialization/type-analysis/analysis";
import { FactStore } from "../specialization/framework/fact-store";
import { constAnalysisPass, typeAnalysisPass } from "../specialization/framework/migrated-passes";
import {
  BOOL_BIT,
  INT_BIT,
  STR_BIT,
  CLOSURE_BIT,
  NULL_BIT,
  FLOAT_BIT,
} from "../specialization/type-analysis/lattice";
import { constOf, CONST_TOP } from "../specialization/const-analysis/lattice";

let nextId = 1;
const freshId = () => nextId++;

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
  ])("%s → correct kind bit on type fact", (_name, raw, expectedBit) => {
    const fs = new FactStore();
    const id = freshId();
    m.observeWrite!(fs, id, raw);
    const t = fs.tryRead(typeAnalysisPass,id);
    expect(t).toBeDefined();
    expect(t!.kinds & expectedBit).toBeTruthy();
  });

  test.each([
    ["tagged number", { type: "number", value: 42 }, INT_BIT],
    ["tagged bool", { type: "bool", value: true }, BOOL_BIT],
    ["tagged string", { type: "string", value: "x" }, STR_BIT],
    ["tagged none", { type: "none" }, NULL_BIT],
    ["tagged closure", { type: "closure", closure: {} }, CLOSURE_BIT],
    ["tagged function", { type: "function" }, CLOSURE_BIT],
    ["tagged builtin", { type: "builtin" }, CLOSURE_BIT],
  ])("%s → correct kind bit on type fact", (_name, raw, expectedBit) => {
    const fs = new FactStore();
    const id = freshId();
    m.observeWrite!(fs, id, raw);
    const t = fs.tryRead(typeAnalysisPass,id);
    expect(t).toBeDefined();
    expect(t!.kinds & expectedBit).toBeTruthy();
  });

  test("unknown shape leaves fact unchanged", () => {
    const fs = new FactStore();
    const id = freshId();
    m.observeWrite!(fs, id, { foo: "bar" });
    expect(fs.tryRead(typeAnalysisPass,id)).toBeUndefined();
    m.observeWrite!(fs, id, Symbol("x"));
    expect(fs.tryRead(typeAnalysisPass,id)).toBeUndefined();
  });

  test("widens (join) when fact already has a type", () => {
    const fs = new FactStore();
    const id = freshId();
    m.observeWrite!(fs, id, 42);
    m.observeWrite!(fs, id, "hello");
    const t = fs.tryRead(typeAnalysisPass,id)!;
    expect(t.kinds & INT_BIT).toBeTruthy();
    expect(t.kinds & STR_BIT).toBeTruthy();
  });

  test("preserves other fact fields (distinct pass cells)", () => {
    const fs = new FactStore();
    const id = freshId();
    fs.write(constAnalysisPass,id, constOf(42));
    m.observeWrite!(fs, id, 42);
    expect(fs.tryRead(constAnalysisPass,id)).toEqual(constOf(42));
    expect(fs.tryRead(typeAnalysisPass,id)).toBeDefined();
  });
});

describe("ConstAnalysisPass.observeWrite", () => {
  const m = new ConstAnalysisPass();

  test("primitive number → constVal set", () => {
    const fs = new FactStore();
    const id = freshId();
    m.observeWrite!(fs, id, 42);
    expect(fs.tryRead(constAnalysisPass,id)).toEqual(constOf(42));
  });

  test("primitive string → constVal set", () => {
    const fs = new FactStore();
    const id = freshId();
    m.observeWrite!(fs, id, "hello");
    expect(fs.tryRead(constAnalysisPass,id)).toEqual(constOf("hello"));
  });

  test("primitive bool → constVal set", () => {
    const fs = new FactStore();
    const id = freshId();
    m.observeWrite!(fs, id, true);
    expect(fs.tryRead(constAnalysisPass,id)).toEqual(constOf(true));
  });

  test("tagged number → constVal set", () => {
    const fs = new FactStore();
    const id = freshId();
    m.observeWrite!(fs, id, { type: "number", value: 42 });
    expect(fs.tryRead(constAnalysisPass,id)).toEqual(constOf(42));
  });

  test("non-primitive leaves fact unchanged (does not widen to CONST_TOP)", () => {
    // Critical: widening to CONST_TOP would erase existing constants.
    const fs = new FactStore();
    const id = freshId();
    fs.write(constAnalysisPass,id, constOf(42));
    m.observeWrite!(fs, id, { type: "closure" });
    expect(fs.tryRead(constAnalysisPass,id)).toEqual(constOf(42));
    m.observeWrite!(fs, id, { type: "list", value: [] });
    expect(fs.tryRead(constAnalysisPass,id)).toEqual(constOf(42));
    m.observeWrite!(fs, id, null);
    expect(fs.tryRead(constAnalysisPass,id)).toEqual(constOf(42));
  });

  test("same value twice → unchanged constVal", () => {
    const fs = new FactStore();
    const id = freshId();
    fs.write(constAnalysisPass,id, constOf(42));
    m.observeWrite!(fs, id, 42);
    expect(fs.tryRead(constAnalysisPass,id)).toEqual(constOf(42));
  });

  test("different values → widens to CONST_TOP", () => {
    const fs = new FactStore();
    const id = freshId();
    fs.write(constAnalysisPass,id, constOf(42));
    m.observeWrite!(fs, id, 99);
    expect(fs.tryRead(constAnalysisPass,id)).toEqual(CONST_TOP);
  });

  test("preserves other fact fields (distinct pass cells)", () => {
    const fs = new FactStore();
    const id = freshId();
    m.observeWrite!(fs, id, 42);
    expect(fs.tryRead(constAnalysisPass,id)).toEqual(constOf(42));
  });
});
