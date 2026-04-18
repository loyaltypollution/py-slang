/**
 * Worklist analysis-graph dispatch layer.
 *
 * Exercises `register` / `enqueue` / `drain` without touching any production
 * analysis / transform. Every analysis is constructed inline with minimal lattices
 * so the test isolates the dispatch rule — "a lattice-change write fans out
 * to declared readers only".
 */
import { parse } from "../../../parser/parser-adapter";
import { Resolver } from "../../../resolver";
import { Worklist } from "../../../specialization/framework/worklist";
import type { EdgeSpec, Lattice, Analysis, TransformRule } from "../../../specialization/framework/analysis";
import type { FunctionUnit } from "../../../specialization/framework/function-unit";

// ── Fixtures ────────────────────────────────────────────────────────────────

function buildWorklist(src = "x = 1\n"): Worklist {
  const ast = parse(src);
  const resolver = new Resolver(src, ast);
  resolver.resolve(ast);
  return new Worklist(ast, resolver.functionEnvironments, [], undefined, []);
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

function saturatingBucket(ceiling: number): Lattice<number> {
  return {
    bottom: 0,
    leq: (a, b) => a <= b,
    join: (a, b) => Math.min(ceiling, Math.max(a, b)),
  };
}

function identityWake<K>(analysis: Analysis<any, any>): EdgeSpec<K> {
  return { on: "fact", analysis, wake: (_c, k) => [k as K] };
}

function makeAnalysis<K, V>(opts: {
  name: string;
  lattice: Lattice<V>;
  edges?: ReadonlyArray<EdgeSpec<K>>;
  tier?: "runtime" | "analysis";
  transfer?: (key: K) => V | undefined;
}): Analysis<K, V> {
  return {
    id: Symbol(opts.name),
    debugName: opts.name,
    lattice: opts.lattice,
    edges: opts.edges ?? [],
    tier: opts.tier ?? "analysis",
    transfer: (_fs, _ctx, key) => (opts.transfer ? opts.transfer(key as K) : undefined),
  };
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe("Worklist analysis-graph dispatch", () => {
  test("(a) saturating lattice at ceiling: consumer not re-enqueued", () => {
    const wl = buildWorklist();
    const producer = makeAnalysis<string, number>({
      name: "producer",
      lattice: saturatingBucket(3),
    });
    let consumerRuns = 0;
    const consumer = makeAnalysis<string, number>({
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

    wl.factStore.write(producer, "k", 3);
    wl.drain();
    const runsAtCeiling = consumerRuns;

    wl.factStore.write(producer, "k", 3);
    wl.factStore.write(producer, "k", 3);
    wl.drain();
    expect(consumerRuns).toBe(runsAtCeiling);
  });

  test("(b) write to unread analysis wakes no consumers", () => {
    const wl = buildWorklist();
    const unread = makeAnalysis<string, number>({ name: "unread", lattice: intMax });
    const consumer = makeAnalysis<string, number>({
      name: "consumer",
      lattice: intMax,
      edges: [],
      transfer: () => 1,
    });
    wl.register(unread);
    wl.register(consumer);
    wl.factStore.write(consumer, "k", 1);

    let enqueued = false;
    const observer = makeAnalysis<string, number>({
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
    const consumer2 = makeAnalysis<string, number>({
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

  test("(c) onUnitRebuilt fires once per pending rebuild, with fresh CFG", () => {
    const wl = buildWorklist("def f():\n    return 1\n");
    const rebuildEvents: FunctionUnit[] = [];
    const observer = makeAnalysis<FunctionUnit, number>({
      name: "observer",
      lattice: intMax,
      edges: [
        { on: "rebuild", effect: (_fs, _ctx, u) => { rebuildEvents.push(u); } },
      ],
      transfer: () => undefined,
    });
    wl.register(observer);

    const fDef = [...wl.units.keys()].find(
      n => n.constructor.name === "FunctionDef",
    )!;
    const fUnit = wl.units.get(fDef)!;

    // Drive a rebuild through the real contract: a one-shot transform on the
    // target unit. Worklist sees `sweep → true`, schedules `fUnit` for CFG
    // rebuild, fires `onUnitRebuilt`.
    let fired = false;
    const oneShot: TransformRule = {
      id: Symbol("oneShot"),
      debugName: "oneShot",
      sweep: unit => {
        if (fired || unit !== fUnit) return false;
        fired = true;
        return true;
      },
    };
    wl.registerTransform(oneShot);
    wl.drain();

    expect(rebuildEvents).toEqual([fUnit]);
  });

  test("(d) transform sweeps after analyses converge within a drain iteration", () => {
    const wl = buildWorklist();
    const order: string[] = [];
    const analysis = makeAnalysis<FunctionUnit, number>({
      name: "analysis",
      lattice: intMax,
      tier: "analysis",
      edges: [
        { on: "mint", wake: (_ctx, u) => [u] },
      ],
      transfer: () => {
        order.push("analysis");
        return undefined;
      },
    });
    const transform: TransformRule = {
      id: Symbol("transform"),
      debugName: "transform",
      sweep() {
        order.push("transform");
        return false;
      },
    };
    wl.register(analysis);
    wl.registerTransform(transform);
    wl.drain();

    expect(order[0]).toBe("analysis");
    expect(order).toContain("transform");
    expect(order.lastIndexOf("analysis")).toBeLessThan(order.indexOf("transform"));
  });

  test("(e) transform that fires triggers CFG rebuild and onUnitRebuilt", () => {
    const wl = buildWorklist();
    const rebuilt: FunctionUnit[] = [];
    const observer = makeAnalysis<FunctionUnit, number>({
      name: "observer",
      lattice: intMax,
      edges: [
        { on: "rebuild", effect: (_fs, _ctx, u) => { rebuilt.push(u); } },
      ],
      transfer: () => undefined,
    });
    let fired = false;
    const transform: TransformRule = {
      id: Symbol("one-shot"),
      debugName: "one-shot",
      sweep() {
        if (fired) return false;
        fired = true;
        return true;
      },
    };
    wl.register(observer);
    wl.registerTransform(transform);
    wl.drain();

    expect(fired).toBe(true);
    expect(rebuilt.length).toBe(1);
  });

  test("top-only lattice: re-write of 'fired' suppresses re-enqueue", () => {
    const wl = buildWorklist();
    const rule = makeAnalysis<string, "fired">({
      name: "rule",
      lattice: topOnly,
    });
    let reads = 0;
    const reader = makeAnalysis<string, number>({
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
    const producer = makeAnalysis<number, number>({
      name: "producer",
      lattice: intMax,
    });
    const seenKeys: number[] = [];
    const reader = makeAnalysis<number, number>({
      name: "reader",
      lattice: intMax,
      edges: [{ on: "fact", analysis: producer, wake: (_c, k) => [k as number] }],
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
      const producer = makeAnalysis<number, number>({
        name: "producer",
        lattice: intMax,
      });
      const order: number[] = [];
      const reader = makeAnalysis<number, number>({
        name: "reader",
        lattice: intMax,
        edges: [{ on: "fact", analysis: producer, wake: (_c, k) => [k as number] }],
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
