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
import type { EdgeSpec, Lattice, Pass } from "../../../specialization/framework/pass";
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
  leq: (a, b) => a <= b,
  join: (a, b) => Math.max(a, b),
};

const topOnly: Lattice<"fired"> = {
  bottom: "fired",
  leq: () => true,
  join: () => "fired",
};

/** Saturating bucket: clamps at `ceiling`; equality gate suppresses writes past ceiling. */
function saturatingBucket(ceiling: number): Lattice<number> {
  return {
    bottom: 0,
    leq: (a, b) => a <= b,
    join: (a, b) => Math.min(ceiling, Math.max(a, b)),
  };
}

/** Default wake: identity projection from upstream key → [same key]. Mirrors
 *  the semantics of pre-edge `coarse:true` for tests whose consumer key-space
 *  matches the upstream's. */
function identityWake<K>(pass: Pass<any, any>): EdgeSpec<K> {
  return { pass, wake: (_c, k) => [k as K] };
}

function makePass<K, V>(opts: {
  name: string;
  lattice: Lattice<V>;
  edges?: ReadonlyArray<EdgeSpec<K>>;
  tier?: "runtime" | "analysis" | "transform";
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
    edges: opts.edges ?? [],
    tier: opts.tier,
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
      edges: [identityWake(producer)],
      transfer: () => {
        consumerRuns++;
        return 1;
      },
    });
    wl.register(producer);
    wl.register(consumer);

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
    wl.factStore.write(producer, "k", 3);
    wl.factStore.write(producer, "k", 3);
    wl.drain();
    expect(consumerRuns).toBe(runsAtCeiling);
  });

  test("(b) write to unread pass wakes no consumers", () => {
    const wl = buildWorklist();
    const unread = makePass<string, number>({ name: "unread", lattice: intMax });
    const consumer = makePass<string, number>({
      name: "consumer",
      lattice: intMax,
      edges: [],
      transfer: () => 1,
    });
    wl.register(unread);
    wl.register(consumer);
    wl.factStore.write(consumer, "k", 1);

    let enqueued = false;
    const observer = makePass<string, number>({
      name: "observer",
      lattice: intMax,
      edges: [identityWake(unread)],
      transfer: () => {
        enqueued = true;
        return undefined;
      },
    });
    wl.register(observer);
    wl.factStore.write(observer, "k", 1);

    wl.factStore.write(unread, "k", 5);
    wl.drain();
    expect(enqueued).toBe(true);

    let consumerRan = false;
    const consumer2 = makePass<string, number>({
      name: "consumer2",
      lattice: intMax,
      edges: [],
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
      edges: [identityWake(structuralPass)],
      transfer: () => 1,
    });
    const nonReader = makePass<FunctionUnit, number>({
      name: "non-reader",
      lattice: intMax,
      edges: [],
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
      edges: [identityWake(structuralPass)],
      transfer: () => {
        readerRuns++;
        return undefined;
      },
    });
    const nonReaderSpy = makePass<FunctionUnit, number>({
      name: "non-reader-spy",
      lattice: intMax,
      edges: [],
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
      edges: [identityWake(structuralPass)],
      tier: "analysis",
      transfer: () => {
        order.push("analysis");
        return undefined;
      },
    });
    const transform = makePass<FunctionUnit, number>({
      name: "transform",
      lattice: intMax,
      edges: [identityWake(structuralPass)],
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
      edges: [identityWake(structuralPass)],
      transfer: () => undefined,
      // On structural rebuild, evict every previous key (simulating "all
      // BlockIds belonged to the old CFG").
      prune: (_unit, prev) => Array.from(prev),
    });
    wl.register(blockKeyed);

    wl.factStore.write(blockKeyed, "b0", 1);
    wl.factStore.write(blockKeyed, "b1", 2);
    expect(wl.factStore.readAll(blockKeyed).size).toBe(2);

    const [unit] = [...wl.units.values()];
    wl.factStore.write(structuralPass, unit, 99);

    expect(wl.factStore.readAll(blockKeyed).size).toBe(0);
  });

  test("top-only lattice: re-write of 'fired' suppresses re-enqueue", () => {
    const wl = buildWorklist();
    const rule = makePass<string, "fired">({
      name: "rule",
      lattice: topOnly,
    });
    let reads = 0;
    const reader = makePass<string, number>({
      name: "reader",
      lattice: intMax,
      edges: [identityWake(rule)],
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

    wl.factStore.write(rule, "n1", "fired");
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
      edges: [{ pass: producer, wake: (_c, k) => [k as number] }],
      transfer: (k) => {
        seenKeys.push(k);
        return undefined;
      },
    });
    wl.register(producer);
    wl.register(reader);

    for (let i = 0; i < 10; i++) wl.factStore.write(reader, i, 1);
    seenKeys.length = 0;

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
        edges: [{ pass: producer, wake: (_c, k) => [k as number] }],
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
        expect(midOrderLen).toBe(0);
        wl.endBatch();
      }
      wl.drain();
      runs.push({ batched, order: order.slice() });
    }

    expect(runs[0].order).toEqual(runs[1].order);

    const wl = buildWorklist();
    expect(() => wl.endBatch()).toThrow(/matching beginBatch/);
  });
});
