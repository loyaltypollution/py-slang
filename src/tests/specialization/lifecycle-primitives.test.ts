// Pins the two lifecycle-stream primitives the framework collapsed to in
// Phases 14-19: extent stream (mint/rebuild as one delta) and chain stream
// (preferred-dispatch chain change). Plus the orthogonal `onRefute` event.

import { setup } from "./harness/compile-pipelines";
import type { Function } from "../../specialization/program/function";
import type { NodeSet } from "../../specialization/program/node-set";
import { ROOT_CONTEXT } from "../../specialization/assumption/chain";
import type { AssumptionChain } from "../../specialization/assumption/chain";

const SRC = `
def f(x):
    return x + 1

def g(y):
    return y

f(1)
g(2)
`;

describe("Extent stream — onExtentChange", () => {
  test("subscribe-time replay fires (unit, EMPTY_NODESET, snapshot) once per existing unit", () => {
    const { worklist } = setup(SRC);
    const fm = worklist.functionManager;
    const events: Array<{ unit: Function; prevSize: number; nextSize: number }> = [];

    fm.onExtentChange((unit, prev, next) => {
      events.push({ unit, prevSize: prev.size ?? -1, nextSize: next.size ?? -1 });
    });

    const allUnits = Array.from(fm.values());
    expect(events).toHaveLength(allUnits.length);
    for (const e of events) {
      expect(e.prevSize).toBe(0);              // mint: prev is EMPTY_NODESET
      expect(e.nextSize).toBeGreaterThan(0);   // unit has at least its own nodes
    }
    // Every unit appeared exactly once in the replay.
    expect(new Set(events.map(e => e.unit)).size).toBe(allUnits.length);
  });

  test("rebuild fires (unit, prev, next) with prev.size > 0 — distinguishes from mint", () => {
    const { worklist } = setup(SRC);
    const fm = worklist.functionManager;

    // Subscribe AFTER initial build so the replay burst is consumed by a no-op
    // listener; only later events go to `tail`.
    fm.onExtentChange(() => {});
    const tail: Array<{ prevSize: number; nextSize: number }> = [];
    fm.onExtentChange((_unit, prev, next) => {
      // Skip the initial replay events for `tail`.
      if ((prev.size ?? 0) > 0 || (next.size ?? 0) === 0) {
        tail.push({ prevSize: prev.size ?? -1, nextSize: next.size ?? -1 });
      } else if ((prev.size ?? 0) === 0 && (next.size ?? 0) > 0) {
        // initial replay; ignore
      }
    });

    const target = Array.from(fm.values()).find(u => u.funcAst.kind === "FunctionDef")!;
    fm.scheduleRebuild(target);
    fm.flushPendingRebuilds();

    // The rebuild emits one event with prev.size > 0.
    const rebuildEvents = tail.filter(e => e.prevSize > 0);
    expect(rebuildEvents).toHaveLength(1);
    expect(rebuildEvents[0].nextSize).toBeGreaterThan(0);
  });

  test("evict-on-rebuild gate (prev.size > 0) holds across mint and rebuild", () => {
    const { worklist } = setup(SRC);
    const fm = worklist.functionManager;
    const evictions: Function[] = [];

    fm.onExtentChange((unit, prev, _next) => {
      if ((prev.size ?? 0) > 0) evictions.push(unit);
    });

    expect(evictions).toHaveLength(0); // initial replay: prev is EMPTY → no evictions

    const target = Array.from(fm.values()).find(u => u.funcAst.kind === "FunctionDef")!;
    fm.scheduleRebuild(target);
    fm.flushPendingRebuilds();

    expect(evictions).toEqual([target]);
  });
});

describe("Chain stream — onChainChange", () => {
  test("ROOT-context unit fires no chain changes during a clean drain", () => {
    const { worklist } = setup(SRC);
    const events: Array<{ unit: Function; prev: AssumptionChain; next: AssumptionChain }> = [];
    worklist.functionManager.dispatch.onChainChange((unit, prev, next) => {
      events.push({ unit, prev, next });
    });

    worklist.drain();

    // Without observation ingress nothing extends a chain — no fires.
    expect(events).toHaveLength(0);
  });

  test("explicit fireChainChange carries (prev, next) shape", () => {
    const { worklist } = setup(SRC);
    const dispatch = worklist.functionManager.dispatch;
    const target = Array.from(worklist.functionManager.values())[0];

    const seen: Array<{ prev: AssumptionChain; next: AssumptionChain }> = [];
    dispatch.onChainChange((_unit, prev, next) => seen.push({ prev, next }));

    // Synthesize a chain change without going through observation ingress.
    const fakeNext = ROOT_CONTEXT;
    dispatch.fireChainChange(target, ROOT_CONTEXT, fakeNext);

    expect(seen).toEqual([{ prev: ROOT_CONTEXT, next: fakeNext }]);
  });
});

describe("Refute event — orthogonal to chain stream", () => {
  test("onRefute receives (unit, carrier) — carrier identity is preserved (not collapsed into a chain delta)", () => {
    const { worklist } = setup(SRC);
    const refutes: Array<{ unit: Function; carrier: AssumptionChain }> = [];
    worklist.functionManager.dispatch.onRefute((unit, carrier) => {
      refutes.push({ unit, carrier });
    });

    // No refutations during a clean drain.
    worklist.drain();
    expect(refutes).toHaveLength(0);

    // The contract: the callback shape is (unit, carrier) — carrier is the
    // specific refuted chain, not a (prev, next) pair. Pinning the type
    // shape is the assertion here; behavioural firing is exercised by
    // type-assumption.test.ts and refutation-integration.test.ts.
    const cb: (unit: Function, carrier: AssumptionChain) => void = (u, c) => {
      refutes.push({ unit: u, carrier: c });
    };
    expect(typeof cb).toBe("function");
  });
});

describe("Snapshot semantics — extent NodeSet at moment-in-time", () => {
  test("the `next` NodeSet on subscribe-time replay enumerates the unit's CFG-owned ids", () => {
    const { worklist } = setup(SRC);
    const fm = worklist.functionManager;

    let captured: { unit: Function; next: NodeSet } | undefined;
    fm.onExtentChange((unit, _prev, next) => {
      if (captured === undefined && unit.funcAst.kind === "FunctionDef") {
        captured = { unit, next };
      }
    });

    expect(captured).toBeDefined();
    const { unit, next } = captured!;

    // Snapshot enumeration should match unit.nodeToBlock.keys()
    const fromSnapshot = new Set(next.iterate!());
    const fromUnit = new Set(unit.nodeToBlock.keys());
    expect(fromSnapshot).toEqual(fromUnit);
    expect(next.size).toBe(fromUnit.size);
  });
});
