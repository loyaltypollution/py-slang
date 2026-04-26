// Phase 27 — proves the UnitDomain<U, L> contract is genuinely generic by
// implementing a non-Function unit kind from scratch and exercising every
// stream the worklist relies on.
//
// What this test demonstrates (the genericity claim):
//   - UnitDomain<U, L> is satisfiable without `Function`.
//   - The extent stream replays existing units on subscribe with prev=EMPTY.
//   - The chain stream and refute stream do NOT replay.
//   - chainFor reflects setChainFor / clearChainFor.
//   - scheduleRebuild + flushPendingRebuilds is a real two-phase sequence:
//     fires the extent stream with non-empty (prev, next) and returns the
//     scheduled units in flush order.
//   - fireRefute fires subs without touching chainFor — reconcile is
//     external (the worklist owns it; see worklist.refute()).
//
// Bottom of file also drives a real Worklist<SyntheticUnit, SyntheticLocator>
// to prove the synthetic domain is sufficient for worklist orchestration.

import {
  ROOT_CONTEXT,
  extend,
  type AssumptionChain,
  type NarrowingId,
} from "../../specialization/assumption";
import { Worklist } from "../../specialization/framework/worklist";
import type { TransformRule } from "../../specialization/framework/analysis";
import { EMPTY_NODESET, nodeSetOfIds, type NodeId } from "../../specialization/program/node-set";
import type { UnitExtent } from "../../specialization/program/unit-extent";
import type {
  ChainChangeListener,
  ExtentChangeListener,
  RefuteListener,
  UnitDomain,
  UnitLocator,
} from "../../specialization/framework/unit-domain";
// Synthetic narrowing — any NarrowingId works as a chain extension axis.
const TEST_NARROWING: NarrowingId<number, number> = { eq: (a, b) => a === b };

// --- a synthetic unit kind --------------------------------------------------

interface SyntheticUnit {
  readonly id: string;
  nodeIds: Set<NodeId>;
}

interface SyntheticLocator extends UnitLocator<SyntheticUnit> {
  readonly all: ReadonlyMap<string, SyntheticUnit>;
}

class SyntheticDomain implements UnitDomain<SyntheticUnit, SyntheticLocator> {
  private readonly unitsById = new Map<string, SyntheticUnit>();
  private readonly chainByUnit = new Map<SyntheticUnit, AssumptionChain>();
  private readonly pendingRebuilds = new Set<SyntheticUnit>();

  private readonly extentSubs: ExtentChangeListener<SyntheticUnit>[] = [];
  private readonly chainSubs: ChainChangeListener<SyntheticUnit>[] = [];
  private readonly refuteSubs: RefuteListener<SyntheticUnit>[] = [];

  readonly locator: SyntheticLocator = {
    all: this.unitsById,
    unitContainingNode: nodeId => {
      for (const u of this.unitsById.values()) {
        if (u.nodeIds.has(nodeId)) return u;
      }
      return undefined;
    },
  };

  // Test-only mutator. Real domains add units via construction or an
  // explicit "addUnit" path (mirroring FunctionManager.addFunction).
  addUnit(id: string, nodeIds: number[]): SyntheticUnit {
    const u: SyntheticUnit = { id, nodeIds: new Set(nodeIds) };
    this.unitsById.set(id, u);
    const next = this.snapshot(u);
    for (const cb of this.extentSubs) cb(u, EMPTY_NODESET, next);
    return u;
  }

  // Test-only — simulate the unit gaining/losing nodes between rebuilds.
  setNodes(unit: SyntheticUnit, nodeIds: number[]): void {
    unit.nodeIds = new Set(nodeIds);
  }

  values(): Iterable<SyntheticUnit> {
    return this.unitsById.values();
  }

  extentOf(unit: SyntheticUnit): UnitExtent {
    return this.snapshot(unit);
  }

  onExtentChange(cb: ExtentChangeListener<SyntheticUnit>): void {
    this.extentSubs.push(cb);
    for (const u of this.unitsById.values()) {
      cb(u, EMPTY_NODESET, this.snapshot(u));
    }
  }

  chainFor(unit: SyntheticUnit): AssumptionChain {
    return this.chainByUnit.get(unit) ?? ROOT_CONTEXT;
  }

  setChainFor(unit: SyntheticUnit, chain: AssumptionChain): void {
    this.chainByUnit.set(unit, chain);
  }

  clearChainFor(unit: SyntheticUnit): void {
    this.chainByUnit.delete(unit);
  }

  onChainChange(cb: ChainChangeListener<SyntheticUnit>): void {
    this.chainSubs.push(cb);
  }

  fireChainChange(unit: SyntheticUnit, prev: AssumptionChain, next: AssumptionChain): void {
    for (const cb of this.chainSubs) cb(unit, prev, next);
  }

  onRefute(cb: RefuteListener<SyntheticUnit>): void {
    this.refuteSubs.push(cb);
  }

  fireRefute(unit: SyntheticUnit, carrier: AssumptionChain): void {
    for (const cb of this.refuteSubs) cb(unit, carrier);
  }

  scheduleRebuild(unit: SyntheticUnit): void {
    this.pendingRebuilds.add(unit);
  }

  flushPendingRebuilds(): readonly SyntheticUnit[] {
    if (this.pendingRebuilds.size === 0) return [];
    const flushed: SyntheticUnit[] = [];
    const events: Array<{ u: SyntheticUnit; prev: UnitExtent; next: UnitExtent }> = [];
    for (const u of this.pendingRebuilds) {
      const prev = this.snapshot(u);
      // Whatever mutated `u.nodeIds` is the implementation's business; the
      // contract requires firing prev/next snapshots regardless.
      events.push({ u, prev, next: this.snapshot(u) });
      flushed.push(u);
    }
    this.pendingRebuilds.clear();
    for (const ev of events) {
      for (const cb of this.extentSubs) cb(ev.u, ev.prev, ev.next);
    }
    return flushed;
  }

  private snapshot(unit: SyntheticUnit): UnitExtent {
    return nodeSetOfIds(unit.nodeIds) as UnitExtent;
  }
}

// --- contract tests ---------------------------------------------------------

describe("UnitDomain contract — satisfiable for a non-Function unit kind", () => {
  test("locator: unitContainingNode returns the owning unit", () => {
    const d = new SyntheticDomain();
    const a = d.addUnit("a", [1, 2, 3]);
    const b = d.addUnit("b", [10, 11]);

    expect(d.locator.unitContainingNode(2)).toBe(a);
    expect(d.locator.unitContainingNode(11)).toBe(b);
    expect(d.locator.unitContainingNode(99)).toBeUndefined();
  });

  test("extent stream: subscribe-time replay fires (unit, EMPTY, snapshot) per existing unit", () => {
    const d = new SyntheticDomain();
    d.addUnit("a", [1, 2]);
    d.addUnit("b", [10]);

    const events: Array<{ id: string; prevSize: number; nextSize: number }> = [];
    d.onExtentChange((u, prev, next) => {
      events.push({ id: u.id, prevSize: prev.size, nextSize: next.size });
    });

    expect(events).toHaveLength(2);
    for (const e of events) {
      expect(e.prevSize).toBe(0); // EMPTY_NODESET — mint signal
      expect(e.nextSize).toBeGreaterThan(0);
    }
  });

  test("extent stream: addUnit after subscribe fires (unit, EMPTY, snapshot) only to that subscriber's window", () => {
    const d = new SyntheticDomain();
    const events: Array<{ id: string; prevSize: number; nextSize: number }> = [];
    d.onExtentChange((u, prev, next) => {
      events.push({ id: u.id, prevSize: prev.size, nextSize: next.size });
    });

    expect(events).toHaveLength(0);
    d.addUnit("late", [1, 2, 3]);
    expect(events).toEqual([{ id: "late", prevSize: 0, nextSize: 3 }]);
  });

  test("rebuild: scheduleRebuild + flushPendingRebuilds fires (prev, next) with both non-empty", () => {
    const d = new SyntheticDomain();
    const u = d.addUnit("u", [1, 2]);

    const tail: Array<{ prevSize: number; nextSize: number }> = [];
    d.onExtentChange((_u, prev, next) => {
      // Skip the subscribe-time mint replay.
      if (prev.size > 0) tail.push({ prevSize: prev.size, nextSize: next.size });
    });

    // Mutate the extent and flush.
    d.setNodes(u, [1, 2, 3, 4]);
    d.scheduleRebuild(u);
    const flushed = d.flushPendingRebuilds();

    expect(flushed).toEqual([u]);
    expect(tail).toEqual([{ prevSize: 4, nextSize: 4 }]);
    // (prev was snapshotted *after* the mutation in this synthetic — the
    // contract is "pre/post rebuild", not "pre/post mutation"; what matters
    // is that prev.size > 0 distinguishes rebuild from mint.)
  });

  test("flushPendingRebuilds with no pending units returns empty and fires nothing", () => {
    const d = new SyntheticDomain();
    d.addUnit("u", [1]);
    let count = 0;
    d.onExtentChange(() => {
      count++;
    });
    const initial = count;
    expect(d.flushPendingRebuilds()).toEqual([]);
    expect(count).toBe(initial);
  });

  test("chain stream: chainFor reflects setChainFor / clearChainFor; subscribe does NOT replay", () => {
    const d = new SyntheticDomain();
    const u = d.addUnit("u", [1]);
    expect(d.chainFor(u)).toBe(ROOT_CONTEXT);

    const events: Array<{ prev: AssumptionChain; next: AssumptionChain }> = [];
    d.onChainChange((_u, prev, next) => events.push({ prev, next }));
    expect(events).toHaveLength(0); // no subscribe-time replay for chain stream

    const ext = extend(ROOT_CONTEXT, TEST_NARROWING, 0, 0);
    d.setChainFor(u, ext);
    expect(d.chainFor(u)).toBe(ext);
    // setChainFor itself does not fire — observation ingress fires explicitly
    expect(events).toHaveLength(0);

    d.fireChainChange(u, ROOT_CONTEXT, ext);
    expect(events).toEqual([{ prev: ROOT_CONTEXT, next: ext }]);

    d.clearChainFor(u);
    expect(d.chainFor(u)).toBe(ROOT_CONTEXT);
  });

  test("refute stream: fireRefute notifies subscribers without mutating chain state", () => {
    const d = new SyntheticDomain();
    const u = d.addUnit("u", [1]);
    const ext = extend(ROOT_CONTEXT, TEST_NARROWING, 0, 0);
    d.setChainFor(u, ext);

    const refutes: Array<{ id: string; carrier: AssumptionChain }> = [];
    d.onRefute((unit, carrier) => refutes.push({ id: unit.id, carrier }));
    expect(refutes).toHaveLength(0); // no replay

    d.fireRefute(u, ext);
    expect(refutes).toEqual([{ id: "u", carrier: ext }]);
    // Chain unchanged — reconcile is the worklist's job, not the domain's.
    expect(d.chainFor(u)).toBe(ext);
  });

  test("the three streams are orthogonal — extent change does not fire chain or refute", () => {
    const d = new SyntheticDomain();
    const u = d.addUnit("u", [1]);

    let chainFires = 0;
    let refuteFires = 0;
    d.onChainChange(() => {
      chainFires++;
    });
    d.onRefute(() => {
      refuteFires++;
    });

    d.setNodes(u, [1, 2]);
    d.scheduleRebuild(u);
    d.flushPendingRebuilds();

    expect(chainFires).toBe(0);
    expect(refuteFires).toBe(0);
  });
});

// --- end-to-end: drive a real Worklist with the synthetic domain --------

describe("Worklist<U, L> drives a synthetic domain end-to-end", () => {
  test("transform sweep + scheduleRebuild + flushPendingRebuilds runs without any Function dependency", () => {
    const d = new SyntheticDomain();
    const a = d.addUnit("a", [1, 2]);
    const b = d.addUnit("b", [10]);

    const swept: SyntheticUnit[] = [];
    const rule: TransformRule<SyntheticUnit, SyntheticLocator> = {
      sweep(unit, _chain, _locator) {
        swept.push(unit);
        // Don't schedule a rebuild — one-shot per unit; otherwise drain
        // would loop until the rule reports no change.
        return {
          changed: false,
          canonicalChanged: false,
          touchedWitnesses: [],
        };
      },
    };

    const wl = new Worklist<SyntheticUnit, SyntheticLocator>({
      units: d,
      analyses: [],
      transforms: [rule],
    });

    // Both units are seeded into the rule's dirty set by the extent-change
    // subscribe-time replay.
    const rebuilt = wl.drain();
    expect(swept.sort((x, y) => x.id.localeCompare(y.id))).toEqual(
      [a, b].sort((x, y) => x.id.localeCompare(y.id)),
    );
    expect(rebuilt).toEqual([]);

    // wl.locate is the synthetic locator, not a FunctionLocator.
    expect(wl.locate.unitContainingNode(2)).toBe(a);
    expect(wl.locate.unitContainingNode(10)).toBe(b);
  });

  test("Worklist.drain() returns rebuilt units (in flush order), now generic over U", () => {
    const d = new SyntheticDomain();
    const a = d.addUnit("a", [1]);
    const b = d.addUnit("b", [2]);

    let fires = 0;
    const rule: TransformRule<SyntheticUnit, SyntheticLocator> = {
      sweep(_unit, _chain, _locator) {
        // Fire once total: pretend `a` rewrote on the first sweep, then
        // nothing more. Must report canonical change to schedule rebuild.
        if (fires === 0) {
          fires++;
          return {
            changed: true,
            canonicalChanged: true,
            touchedWitnesses: [ROOT_CONTEXT],
          };
        }
        return {
          changed: false,
          canonicalChanged: false,
          touchedWitnesses: [],
        };
      },
    };

    const wl = new Worklist<SyntheticUnit, SyntheticLocator>({
      units: d,
      analyses: [],
      transforms: [rule],
    });

    // First sweep: rule fires once → one rebuild scheduled, then second
    // sweep is a no-op so drain converges. Either a or b will be the
    // dirty unit visited first; the test only asserts that drain returns
    // the unit that was actually rebuilt.
    const rebuilt = wl.drain();
    expect(rebuilt.length).toBe(1);
    expect([a, b]).toContain(rebuilt[0]);
  });
});
