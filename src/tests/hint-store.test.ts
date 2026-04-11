/**
 * Tests for HintStore version tracking, change log, changesSince binary search,
 * and hintEquals structural comparison.
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
  describe("version tracking", () => {
    test("version starts at 0", () => {
      const store = new HintStore();
      expect(store.version).toBe(0);
    });

    test("set with new value bumps version, returns true", () => {
      const store = new HintStore();
      const node = fakeNode(1);
      const changed = store.set(node, { type: positiveInteger() });
      expect(changed).toBe(true);
      expect(store.version).toBe(1);
    });

    test("set with structurally equal value does not bump version, returns false", () => {
      const store = new HintStore();
      const node = fakeNode(1);
      store.set(node, { type: positiveInteger() });
      expect(store.version).toBe(1);

      const changed = store.set(node, { type: positiveInteger() });
      expect(changed).toBe(false);
      expect(store.version).toBe(1);
    });

    test("multiple sets on different nodes each bump version", () => {
      const store = new HintStore();
      store.set(fakeNode(1), { type: positiveInteger() });
      store.set(fakeNode(2), { type: negativeInteger() });
      store.set(fakeNode(3), { constVal: constOf(10) });
      expect(store.version).toBe(3);
    });
  });

  describe("changesSince binary search", () => {
    let store: HintStore;

    beforeEach(() => {
      store = new HintStore();
      // Insert 5 changes at versions 1..5
      for (let i = 1; i <= 5; i++) {
        store.set(fakeNode(i), { constVal: constOf(i * 10) });
      }
      expect(store.version).toBe(5);
    });

    test("changesSince(0) returns all changes", () => {
      const changes = store.changesSince(0);
      expect(changes.length).toBe(5);
      expect(changes[0].version).toBe(1);
      expect(changes[4].version).toBe(5);
    });

    test("changesSince(currentVersion) returns empty", () => {
      expect(store.changesSince(5)).toHaveLength(0);
    });

    test("changesSince(mid) returns correct slice", () => {
      const changes = store.changesSince(3);
      expect(changes.length).toBe(2);
      expect(changes[0].version).toBe(4);
      expect(changes[1].version).toBe(5);
    });

    test("changesSince(1) skips the first change", () => {
      const changes = store.changesSince(1);
      expect(changes.length).toBe(4);
      expect(changes[0].version).toBe(2);
    });

    test("change records contain correct oldHint/newHint", () => {
      const changes = store.changesSince(0);
      // First set on each node: oldHint is undefined
      expect(changes[0].oldHint).toBeUndefined();
      expect(changes[0].newHint).toEqual({ constVal: constOf(10) });

      // Now update node 1 — oldHint should be the previous value
      store.set(fakeNode(1), { constVal: constOf(100) });
      const latest = store.changesSince(5);
      expect(latest.length).toBe(1);
      expect(latest[0].oldHint).toEqual({ constVal: constOf(10) });
      expect(latest[0].newHint).toEqual({ constVal: constOf(100) });
    });
  });
});
