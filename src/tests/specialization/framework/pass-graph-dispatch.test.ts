/**
 * PR-2a tests: Worklist's pass-graph dispatch layer.
 *
 * These tests exercise `register` / `enqueue` / `drain` without
 * touching any production analysis / transform. Every pass is constructed
 * inline with minimal lattices so the test isolates the dispatch rule —
 * "a lattice-change write fans out to declared readers only".
 *
 * Coverage:
 *   (a) saturating lattice at ceiling suppresses consumer re-enqueue;
 *   (b) write to an unread pass wakes no consumers;
 *   (c) structural write fans out to declared readers only;
 *   (d) transform defers while analysis is queued for the same unit;
 *   (e) prune hook evicts stale BlockId-shaped keys on CFG rebuild.
 */
import { parse } from "../../../parser/parser-adapter";
import { Resolver } from "../../../resolver";
import { Worklist } from "../../../specialization/framework/worklist";
import { structuralPass } from "../../../specialization/framework/structural-pass";
import type { Lattice, Pass } from "../../../specialization/framework/pass";
import type { FunctionUnit } from "../../../specialization/framework/function-unit";

// ── Fixtures ────────────────────────────────────────────────────────────────

function buildWorklist(src = "x = 1\n"): Worklist {
  const ast = parse(src);
  const resolver = new Resolver(src, ast);
  resolver.resolve(ast);
  return new Worklist(ast, resolver.functionEnvironments);
}

const intMax: Lattice<number> = {
  bottom: 0,
  equals: (a, b) => a === b,
  join: (a, b) => Math.max(a, b),
};

const topOnly: Lattice<"fired"> = {
  bottom: "fired",
  equals: () => true,
  join: () => "fired",
};

/** Saturating bucket: clamps at `ceiling`; equality gate suppresses writes past ceiling. */
function saturatingBucket(ceiling: number): Lattice<number> {
  return {
    bottom: 0,
    equals: (a, b) => a === b,
    join: (a, b) => Math.min(ceiling, Math.max(a, b)),
  };
}

function makePass<K, V>(opts: {
  name: string;
  lattice: Lattice<V>;
  reads?: ReadonlyArray<Pass<any, any>>;
  tier?: "runtime" | "analysis" | "transform";
  coarse?: boolean;
  transfer?: (key: K) => V | undefined;
  affectedKeys?: (p: Pass<any, any>, k: unknown) => Iterable<K>;
  prune?: (
    unit: FunctionUnit,
    prev: Iterable<K>,
  ) => Iterable<K>;
}): Pass<K, V> {
  return {
    id: Symbol(opts.name),
    debugName: opts.name,
    lattice: opts.lattice,
    reads: opts.reads ?? [],
    tier: opts.tier,
    coarse: opts.coarse ?? opts.affectedKeys === undefined,
    transfer: (_ctx, key) => (opts.transfer ? opts.transfer(key as K) : undefined),
    affectedKeys: opts.affectedKeys
      ? (_ctx, p, k) => opts.affectedKeys!(p, k)
      : undefined,
    prune: opts.prune ? (_ctx, unit, prev) => opts.prune!(unit, prev as Iterable<K>) : undefined,
  };
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe("Worklist pass-graph dispatch", () => {
  test("(a) saturating lattice at ceiling: consumer not re-enqueued", () => {
    const wl = buildWorklist();
    const producer = makePass<string, number>({
      name: "producer",
      lattice: saturatingBucket(3),
    });
    let consumerRuns = 0;
    const consumer = makePass<string, number>({
      name: "consumer",
      lattice: intMax,
      reads: [producer],
      coarse: true,
      transfer: () => {
        consumerRuns++;
        return 1;
      },
    });
    wl.register(producer);
    wl.register(consumer);

    // Seed consumer with a key so coarse re-fan has a target.
    wl.factStore.write(consumer, "k", 1);
    consumerRuns = 0;

    wl.factStore.write(producer, "k", 1);
    wl.drain();
    const runsAfterFirst = consumerRuns;
    expect(runsAfterFirst).toBeGreaterThan(0);

    // Push bucket to ceiling.
    wl.factStore.write(producer, "k", 3);
    wl.drain();
    const runsAtCeiling = consumerRuns;

    // Further writes at ceiling must be no-ops (equal under lattice.equals);
    // no onChange fires → consumer not re-enqueued.
    wl.factStore.write(producer, "k", 3); // equal under lattice → suppressed
    wl.factStore.write(producer, "k", 3); // still equal → suppressed
    wl.drain();
    expect(consumerRuns).toBe(runsAtCeiling);
  });

  test("(b) write to unread pass wakes no consumers", () => {
    const wl = buildWorklist();
    const unread = makePass<string, number>({ name: "unread", lattice: intMax });
    const consumer = makePass<string, number>({
      name: "consumer",
      lattice: intMax,
      reads: [], // reads nothing
      coarse: true,
      transfer: () => 1,
    });
    wl.register(unread);
    wl.register(consumer);
    wl.factStore.write(consumer, "k", 1);

    let enqueued = false;
    // Spy by wrapping: re-register of same pass is a no-op, so use an
    // observer pass instead to detect fan-out.
    const observer = makePass<string, number>({
      name: "observer",
      lattice: intMax,
      reads: [unread],
      coarse: true,
      transfer: () => {
        enqueued = true;
        return undefined;
      },
    });
    wl.register(observer);
    wl.factStore.write(observer, "k", 1); // seed observer's key

    // Fire a write to `unread` — `consumer` doesn't read it, `observer` does.
    wl.factStore.write(unread, "k", 5);
    wl.drain();
    expect(enqueued).toBe(true);

    // But consumer (reads nothing) must never have been woken.
    let consumerRan = false;
    const consumer2 = makePass<string, number>({
      name: "consumer2",
      lattice: intMax,
      reads: [],
      coarse: true,
      transfer: () => {
        consumerRan = true;
        return undefined;
      },
    });
    wl.register(consumer2);
    wl.factStore.write(unread, "k", 6);
    wl.drain();
    expect(consumerRan).toBe(false);
  });

  test("(c) structural write fans out to declared readers only", () => {
    const wl = buildWorklist();
    const reader = makePass<FunctionUnit, number>({
      name: "struct-reader",
      lattice: intMax,
      reads: [structuralPass],
      coarse: true,
      transfer: () => 1,
    });
    const nonReader = makePass<FunctionUnit, number>({
      name: "non-reader",
      lattice: intMax,
      reads: [],
      coarse: true,
      transfer: () => 1,
    });
    wl.register(reader);
    wl.register(nonReader);

    const [unit] = [...wl.units.values()];
    wl.factStore.write(reader, unit, 1);
    wl.factStore.write(nonReader, unit, 1);

    let readerRuns = 0;
    let nonReaderRuns = 0;
    const readerSpy = makePass<FunctionUnit, number>({
      name: "reader-spy",
      lattice: intMax,
      reads: [structuralPass],
      coarse: true,
      transfer: () => {
        readerRuns++;
        return undefined;
      },
    });
    const nonReaderSpy = makePass<FunctionUnit, number>({
      name: "non-reader-spy",
      lattice: intMax,
      reads: [],
      coarse: true,
      transfer: () => {
        nonReaderRuns++;
        return undefined;
      },
    });
    wl.register(readerSpy);
    wl.register(nonReaderSpy);
    wl.factStore.write(readerSpy, unit, 1);
    wl.factStore.write(nonReaderSpy, unit, 1);

    wl.factStore.write(structuralPass, unit, 42);
    wl.drain();

    expect(readerRuns).toBeGreaterThan(0);
    expect(nonReaderRuns).toBe(0);
  });

  test("(d) transform defers while analysis is queued for same unit", () => {
    const wl = buildWorklist();
    const order: string[] = [];
    const analysis = makePass<FunctionUnit, number>({
      name: "analysis",
      lattice: intMax,
      reads: [structuralPass],
      coarse: true,
      tier: "analysis",
      transfer: () => {
        order.push("analysis");
        return undefined;
      },
    });
    const transform = makePass<FunctionUnit, number>({
      name: "transform",
      lattice: intMax,
      reads: [structuralPass],
      coarse: true,
      tier: "transform",
      transfer: () => {
        order.push("transform");
        return undefined;
      },
    });
    wl.register(analysis);
    wl.register(transform);

    const [unit] = [...wl.units.values()];
    wl.factStore.write(analysis, unit, 1);
    wl.factStore.write(transform, unit, 1);

    wl.factStore.write(structuralPass, unit, 7);
    wl.drain();

    // analysis must precede transform for the same unit.
    const a = order.indexOf("analysis");
    const t = order.indexOf("transform");
    expect(a).toBeGreaterThanOrEqual(0);
    expect(t).toBeGreaterThan(a);
  });

  test("(e) prune hook evicts stale BlockId-shaped keys on CFG rebuild", () => {
    const wl = buildWorklist();
    const blockKeyed = makePass<string, number>({
      name: "block-keyed",
      lattice: intMax,
      reads: [structuralPass],
      coarse: true,
      transfer: () => undefined,
      // On structural rebuild, evict every previous key (simulating "all
      // BlockIds belonged to the old CFG").
      prune: (_unit, prev) => Array.from(prev),
    });
    wl.register(blockKeyed);

    // Seed some "block" keys.
    wl.factStore.write(blockKeyed, "b0", 1);
    wl.factStore.write(blockKeyed, "b1", 2);
    expect(wl.factStore.readAll(blockKeyed).size).toBe(2);

    // Simulate a CFG rebuild by writing a new AstVersion to structuralPass.
    const [unit] = [...wl.units.values()];
    wl.factStore.write(structuralPass, unit, 99);

    // Prune runs synchronously inside handleFactChange.
    expect(wl.factStore.readAll(blockKeyed).size).toBe(0);
  });

  test("register: fails fast if neither affectedKeys nor coarse is declared", () => {
    const wl = buildWorklist();
    const bad: Pass<string, number> = {
      id: Symbol("bad"),
      debugName: "bad",
      lattice: intMax,
      reads: [],
      transfer: () => undefined,
    };
    expect(() => wl.register(bad)).toThrow(/affectedKeys.*coarse/);
  });

  test("top-only lattice: re-write of 'fired' suppresses re-enqueue", () => {
    const wl = buildWorklist();
    const rule = makePass<string, "fired">({
      name: "rule",
      lattice: topOnly,
      coarse: true,
    });
    let reads = 0;
    const reader = makePass<string, number>({
      name: "reader",
      lattice: intMax,
      reads: [rule],
      coarse: true,
      transfer: () => {
        reads++;
        return undefined;
      },
    });
    wl.register(rule);
    wl.register(reader);
    wl.factStore.write(reader, "k", 1);

    wl.factStore.write(rule, "n1", "fired");
    wl.drain();
    const firstReads = reads;
    expect(firstReads).toBeGreaterThan(0);

    wl.factStore.write(rule, "n1", "fired"); // equal → suppressed
    wl.drain();
    expect(reads).toBe(firstReads);
  });

  test("identity-key reader: runtime write at nodeId X wakes only key X", () => {
    const wl = buildWorklist();
    const producer = makePass<number, number>({
      name: "producer",
      lattice: intMax,
    });
    const seenKeys: number[] = [];
    const reader = makePass<number, number>({
      name: "reader",
      lattice: intMax,
      reads: [producer],
      coarse: false,
      affectedKeys: (_trig, key) => [key as number],
      transfer: (k) => {
        seenKeys.push(k);
        return undefined;
      },
    });
    wl.register(producer);
    wl.register(reader);

    // Pre-populate the reader at many keys so a coarse re-fan would wake all of them.
    for (let i = 0; i < 10; i++) wl.factStore.write(reader, i, 1);
    seenKeys.length = 0;

    // A single producer write at key=3 must wake reader at key=3 only.
    wl.factStore.write(producer, 3, 1);
    wl.drain();

    expect(seenKeys).toEqual([3]);
  });

  test("beginBatch/endBatch: processQueue deferred until outermost endBatch, same fixed point as unbatched", () => {
    const runs: Array<{ batched: boolean; order: number[] }> = [];

    for (const batched of [false, true]) {
      const wl = buildWorklist();
      const producer = makePass<number, number>({
        name: "producer",
        lattice: intMax,
      });
      const order: number[] = [];
      const reader = makePass<number, number>({
        name: "reader",
        lattice: intMax,
        reads: [producer],
        coarse: false,
        affectedKeys: (_trig, key) => [key as number],
        transfer: (k) => {
          order.push(k);
          return undefined;
        },
      });
      wl.register(producer);
      wl.register(reader);
      for (let i = 0; i < 5; i++) wl.factStore.write(reader, i, 1);
      order.length = 0;

      if (batched) wl.beginBatch();
      let midOrderLen = -1;
      for (let i = 0; i < 5; i++) {
        wl.observe(producer, i, 1);
        if (i === 2) midOrderLen = order.length;
      }
      if (batched) {
        // No transfers should have run mid-batch.
        expect(midOrderLen).toBe(0);
        wl.endBatch();
      }
      wl.drain();
      runs.push({ batched, order: order.slice() });
    }

    // Same post-drain sequence of (pass,key) events either way.
    expect(runs[0].order).toEqual(runs[1].order);

    // Tripwire: endBatch without matching beginBatch throws.
    const wl = buildWorklist();
    expect(() => wl.endBatch()).toThrow(/matching beginBatch/);
  });
});
