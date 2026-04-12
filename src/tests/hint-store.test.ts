/**
 * Tests for HintStore write/read + hintEquals structural comparison.
 */

import { ExprNS } from "../ast-types";
import {
  HintStore,
  hintEquals,
  positiveInteger,
  negativeInteger,
  join,
  constOf,
  CONST_BOTTOM,
  CONST_TOP,
} from "../specialization";

/** HintStore only reads node.id — no need for a real AST node. */
function fakeNode(id: number): ExprNS.Expr {
  return { id } as any;
}

describe("hintEquals", () => {
  describe("TypeLattice", () => {
    test("same singleton (fast path ===)", () => {
      expect(hintEquals({ type: positiveInteger() }, { type: positiveInteger() })).toBe(true);
    });

    test("structural match from join products (new objects)", () => {
      const a = join(positiveInteger(), negativeInteger());
      const b = join(positiveInteger(), negativeInteger());
      expect(a).not.toBe(b); // different objects
      expect(hintEquals({ type: a }, { type: b })).toBe(true);
    });

    test("different values", () => {
      expect(hintEquals({ type: positiveInteger() }, { type: negativeInteger() })).toBe(false);
    });

    test("one has type, other does not", () => {
      expect(hintEquals({ type: positiveInteger() }, {})).toBe(false);
      expect(hintEquals({}, { type: positiveInteger() })).toBe(false);
    });

    test("both missing type", () => {
      expect(hintEquals({}, {})).toBe(true);
    });
  });

  describe("ConstLattice", () => {
    test("singleton bottom", () => {
      expect(hintEquals({ constVal: CONST_BOTTOM }, { constVal: CONST_BOTTOM })).toBe(true);
    });

    test("constOf(42) vs constOf(42): different objects, same value", () => {
      const a = constOf(42);
      const b = constOf(42);
      expect(a).not.toBe(b);
      expect(hintEquals({ constVal: a }, { constVal: b })).toBe(true);
    });

    test("constOf(42) vs constOf(43)", () => {
      expect(hintEquals({ constVal: constOf(42) }, { constVal: constOf(43) })).toBe(false);
    });

    test("constOf(42) vs CONST_TOP", () => {
      expect(hintEquals({ constVal: constOf(42) }, { constVal: CONST_TOP })).toBe(false);
    });
  });

  describe("combined type + constVal", () => {
    test("both equal", () => {
      expect(
        hintEquals(
          { type: positiveInteger(), constVal: constOf(42) },
          { type: positiveInteger(), constVal: constOf(42) },
        ),
      ).toBe(true);
    });

    test("type equal but constVal differs", () => {
      expect(
        hintEquals(
          { type: positiveInteger(), constVal: constOf(42) },
          { type: positiveInteger(), constVal: constOf(99) },
        ),
      ).toBe(false);
    });
  });
});

describe("HintStore", () => {
  test("get returns undefined for unknown node", () => {
    const store = new HintStore();
    expect(store.get(fakeNode(1))).toBeUndefined();
  });

  test("set with new value returns true", () => {
    const store = new HintStore();
    expect(store.set(fakeNode(1), { type: positiveInteger() })).toBe(true);
    expect(store.get(fakeNode(1))).toEqual({ type: positiveInteger() });
  });

  test("set with structurally equal value returns false", () => {
    const store = new HintStore();
    const node = fakeNode(1);
    store.set(node, { type: positiveInteger() });
    expect(store.set(node, { type: positiveInteger() })).toBe(false);
  });

  test("iterate yields all (id, hint) pairs", () => {
    const store = new HintStore();
    store.set(fakeNode(1), { type: positiveInteger() });
    store.set(fakeNode(2), { constVal: constOf(10) });
    const entries = [...store];
    expect(entries).toHaveLength(2);
    expect(new Map(entries).get(1)).toEqual({ type: positiveInteger() });
    expect(new Map(entries).get(2)).toEqual({ constVal: constOf(10) });
  });
});
