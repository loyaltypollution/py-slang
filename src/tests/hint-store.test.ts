/**
 * Tests for HintStore write/read + hintEquals registry-dispatched comparison.
 *
 * The prior γ-era hardcoded switch (`case "type" | "constVal"`) is replaced
 * with a registry: `hintEquals` consults the analysis module registered
 * under each field's name and calls its `latticeEquals`. Fields with no
 * registered module default to inequality — callers in this file construct
 * a minimal `{ type: TypeAnalysisPass, constVal: ConstAnalysisPass }`
 * dispatcher to mirror production usage.
 */

import { ExprNS } from "../ast-types";
import {
  ConstAnalysisPass,
  HintStore,
  hintEquals,
  TypeAnalysisPass,
  positiveInteger,
  negativeInteger,
  join,
  constOf,
  CONST_BOTTOM,
  CONST_TOP,
} from "../specialization";
import type { OptimizationHint } from "../specialization/framework/hint";

/** HintStore only reads node.id — no need for a real AST node. */
function fakeNode(id: number): ExprNS.Expr {
  return { id } as any;
}

const registry = new Map<string, { latticeEquals(a: unknown, b: unknown): boolean }>([
  ["type", new TypeAnalysisPass()],
  ["constVal", new ConstAnalysisPass()],
]);
const eq = (a: OptimizationHint, b: OptimizationHint) => hintEquals(a, b, registry);

describe("hintEquals", () => {
  describe("TypeLattice", () => {
    test("same singleton (fast path ===)", () => {
      expect(eq({ type: positiveInteger() }, { type: positiveInteger() })).toBe(true);
    });

    test("structural match from join products (new objects)", () => {
      const a = join(positiveInteger(), negativeInteger());
      const b = join(positiveInteger(), negativeInteger());
      expect(a).not.toBe(b);
      expect(eq({ type: a }, { type: b })).toBe(true);
    });

    test("different values", () => {
      expect(eq({ type: positiveInteger() }, { type: negativeInteger() })).toBe(false);
    });

    test("one has type, other does not", () => {
      expect(eq({ type: positiveInteger() }, {})).toBe(false);
      expect(eq({}, { type: positiveInteger() })).toBe(false);
    });

    test("both missing type", () => {
      expect(eq({}, {})).toBe(true);
    });
  });

  describe("ConstLattice", () => {
    test("singleton bottom", () => {
      expect(eq({ constVal: CONST_BOTTOM }, { constVal: CONST_BOTTOM })).toBe(true);
    });

    test("constOf(42) vs constOf(42): different objects, same value", () => {
      const a = constOf(42);
      const b = constOf(42);
      expect(a).not.toBe(b);
      expect(eq({ constVal: a }, { constVal: b })).toBe(true);
    });

    test("constOf(42) vs constOf(43)", () => {
      expect(eq({ constVal: constOf(42) }, { constVal: constOf(43) })).toBe(false);
    });

    test("constOf(42) vs CONST_TOP", () => {
      expect(eq({ constVal: constOf(42) }, { constVal: CONST_TOP })).toBe(false);
    });
  });

  describe("combined type + constVal", () => {
    test("both equal", () => {
      expect(
        eq(
          { type: positiveInteger(), constVal: constOf(42) },
          { type: positiveInteger(), constVal: constOf(42) },
        ),
      ).toBe(true);
    });

    test("type equal but constVal differs", () => {
      expect(
        eq(
          { type: positiveInteger(), constVal: constOf(42) },
          { type: positiveInteger(), constVal: constOf(99) },
        ),
      ).toBe(false);
    });
  });

  describe("unknown-name dispatch", () => {
    // Regression test for the γ-era `default: return false` monkey patch.
    // With registry dispatch, a fake analysis registered under a custom name
    // lets the caller define non-`===` equality on an extension field.
    test("custom module's latticeEquals is honored", () => {
      const callCountEq = {
        latticeEquals: (a: unknown, b: unknown) => Math.abs((a as number) - (b as number)) < 2,
      };
      const local = new Map(registry);
      local.set("callCount", callCountEq);
      expect(hintEquals({ callCount: 1 }, { callCount: 2 }, local)).toBe(true);
      expect(hintEquals({ callCount: 1 }, { callCount: 5 }, local)).toBe(false);
    });

    test("unregistered field defaults to inequality", () => {
      expect(hintEquals({ extraField: 1 }, { extraField: 2 }, registry)).toBe(false);
    });
  });
});

describe("HintStore", () => {
  test("get returns undefined for unknown node", () => {
    const store = new HintStore(eq);
    expect(store.get(fakeNode(1))).toBeUndefined();
  });

  test("set with new value returns true", () => {
    const store = new HintStore(eq);
    expect(store.set(fakeNode(1), { type: positiveInteger() })).toBe(true);
    expect(store.get(fakeNode(1))).toEqual({ type: positiveInteger() });
  });

  test("set with structurally equal value returns false", () => {
    const store = new HintStore(eq);
    const node = fakeNode(1);
    store.set(node, { type: positiveInteger() });
    expect(store.set(node, { type: positiveInteger() })).toBe(false);
  });

  test("iterate yields all (id, hint) pairs", () => {
    const store = new HintStore(eq);
    store.set(fakeNode(1), { type: positiveInteger() });
    store.set(fakeNode(2), { constVal: constOf(10) });
    const entries = [...store];
    expect(entries).toHaveLength(2);
    expect(new Map(entries).get(1)).toEqual({ type: positiveInteger() });
    expect(new Map(entries).get(2)).toEqual({ constVal: constOf(10) });
  });
});
