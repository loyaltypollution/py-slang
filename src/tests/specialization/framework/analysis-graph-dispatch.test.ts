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
import { defineAnalysis, type EdgeSpec, type Lattice, type Analysis, type StoreAlgebra, type TransformRule } from "../../../specialization/framework/analysis";
import type { Unit } from "../../../specialization/framework/function-unit";
import { ROOT_CONTEXT, extendContext } from "../../../specialization/framework/context";

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
  eq: (a, b) => a === b,
};

const topOnly: Lattice<"fired"> = {
  bottom: "fired",
  leq: () => true,
  join: () => "fired",
  eq: () => true,
};

function saturatingBucket(ceiling: number): Lattice<number> {
  return {
    bottom: 0,
    leq: (a, b) => a <= b,
    join: (a, b) => Math.min(ceiling, Math.max(a, b)),
    eq: (a, b) => Math.min(ceiling, a) === Math.min(ceiling, b),
  };
}

function identityWake<K>(analysis: Analysis<unknown, unknown>): EdgeSpec<K> {
  return { on: "fact", analysis, wake: (_c, k) => [k as K] };
}

function makeAnalysis<K, V>(opts: {
  name: string;
  storeAlgebra: StoreAlgebra<V>;
  edges?: ReadonlyArray<EdgeSpec<K>>;
  tier?: "runtime" | "analysis";
  polarity?: "may" | "must" | "opaque";
  transfer?: (key: K) => V | undefined;
}): Analysis<K, V> {
  return defineAnalysis({
    id: Symbol(opts.name),
    debugName: opts.name,
    storeAlgebra: opts.storeAlgebra,
    edges: opts.edges ?? [],
    tier: opts.tier ?? "analysis",
    polarity: opts.polarity ?? "may",
    transfer: (_ctx, key) => (opts.transfer ? opts.transfer(key) : undefined),
  });
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe("Worklist analysis-graph dispatch", () => {
  test("(a) saturating lattice at ceiling: consumer not re-enqueued", () => {
    const wl = buildWorklist();
    const producer = makeAnalysis<string, number>({
      name: "producer",
      storeAlgebra: saturatingBucket(3),
    });
    let consumerRuns = 0;
    const consumer = makeAnalysis<string, number>({
      name: "consumer",
      storeAlgebra: intMax,
      edges: [identityWake(producer)],
      transfer: () => {
        consumerRuns++;
        return 1;
      },
    });
    wl.register(producer);
    wl.register(consumer);

    wl.write(consumer, "k", 1);
    consumerRuns = 0;

    wl.write(producer, "k", 1);
    wl.drain();
    const runsAfterFirst = consumerRuns;
    expect(runsAfterFirst).toBeGreaterThan(0);

    wl.write(producer, "k", 3);
    wl.drain();
    const runsAtCeiling = consumerRuns;

    wl.write(producer, "k", 3);
    wl.write(producer, "k", 3);
    wl.drain();
    expect(consumerRuns).toBe(runsAtCeiling);
  });

  test("(b) write to unread analysis wakes no consumers", () => {
    const wl = buildWorklist();
    const unread = makeAnalysis<string, number>({ name: "unread", storeAlgebra: intMax });
    const consumer = makeAnalysis<string, number>({
      name: "consumer",
      storeAlgebra: intMax,
      edges: [],
      transfer: () => 1,
    });
    wl.register(unread);
    wl.register(consumer);
    wl.write(consumer, "k", 1);

    let enqueued = false;
    const observer = makeAnalysis<string, number>({
      name: "observer",
      storeAlgebra: intMax,
      edges: [identityWake(unread)],
      transfer: () => {
        enqueued = true;
        return undefined;
      },
    });
    wl.register(observer);
    wl.write(observer, "k", 1);

    wl.write(unread, "k", 5);
    wl.drain();
    expect(enqueued).toBe(true);

    let consumerRan = false;
    const consumer2 = makeAnalysis<string, number>({
      name: "consumer2",
      storeAlgebra: intMax,
      edges: [],
      transfer: () => {
        consumerRan = true;
        return undefined;
      },
    });
    wl.register(consumer2);
    wl.write(unread, "k", 6);
    wl.drain();
    expect(consumerRan).toBe(false);
  });

  test("(c) onUnitRebuilt fires once per pending rebuild, with fresh CFG", () => {
    const wl = buildWorklist("def f():\n    return 1\n");
    const rebuildEvents: Unit[] = [];
    const observer = makeAnalysis<Unit, number>({
      name: "observer",
      storeAlgebra: intMax,
      edges: [
        { on: "rebuild", effect: (_ctx, u) => { rebuildEvents.push(u); } },
      ],
      transfer: () => undefined,
    });
    wl.register(observer);

    const fUnit = [...wl.units.values()].find(
      u => u.funcAst.constructor.name === "FunctionDef",
    )!;

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
    const analysis = makeAnalysis<Unit, number>({
      name: "analysis",
      storeAlgebra: intMax,
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
    const rebuilt: Unit[] = [];
    const observer = makeAnalysis<Unit, number>({
      name: "observer",
      storeAlgebra: intMax,
      edges: [
        { on: "rebuild", effect: (_ctx, u) => { rebuilt.push(u); } },
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

  test("top-only storeAlgebra: re-write of 'fired' suppresses re-enqueue", () => {
    const wl = buildWorklist();
    const rule = makeAnalysis<string, "fired">({
      name: "rule",
      storeAlgebra: topOnly,
    });
    let reads = 0;
    const reader = makeAnalysis<string, number>({
      name: "reader",
      storeAlgebra: intMax,
      edges: [identityWake(rule)],
      transfer: () => {
        reads++;
        return undefined;
      },
    });
    wl.register(rule);
    wl.register(reader);
    wl.write(reader, "k", 1);

    wl.write(rule, "n1", "fired");
    wl.drain();
    const firstReads = reads;
    expect(firstReads).toBeGreaterThan(0);

    wl.write(rule, "n1", "fired");
    wl.drain();
    expect(reads).toBe(firstReads);
  });

  test("identity-key reader: runtime write at nodeId X wakes only key X", () => {
    const wl = buildWorklist();
    const producer = makeAnalysis<number, number>({
      name: "producer",
      storeAlgebra: intMax,
    });
    const seenKeys: number[] = [];
    const reader = makeAnalysis<number, number>({
      name: "reader",
      storeAlgebra: intMax,
      edges: [{ on: "fact", analysis: producer, wake: (_c, k) => [k as number] }],
      transfer: (k) => {
        seenKeys.push(k);
        return undefined;
      },
    });
    wl.register(producer);
    wl.register(reader);

    for (let i = 0; i < 10; i++) wl.write(reader, i, 1);
    seenKeys.length = 0;

    wl.write(producer, 3, 1);
    wl.drain();

    expect(seenKeys).toEqual([3]);
  });

  test("beginBatch/endBatch: processQueue deferred until outermost endBatch, same fixed point as unbatched", () => {
    const runs: Array<{ batched: boolean; order: number[] }> = [];

    for (const batched of [false, true]) {
      const wl = buildWorklist();
      const producer = makeAnalysis<number, number>({
        name: "producer",
        storeAlgebra: intMax,
      });
      const order: number[] = [];
      const reader = makeAnalysis<number, number>({
        name: "reader",
        storeAlgebra: intMax,
        edges: [{ on: "fact", analysis: producer, wake: (_c, k) => [k as number] }],
        transfer: (k) => {
          order.push(k);
          return undefined;
        },
      });
      wl.register(producer);
      wl.register(reader);
      for (let i = 0; i < 5; i++) wl.write(reader, i, 1);
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

  describe("context dispatch", () => {
    test("enqueue under non-ROOT runs transfer with matching currentContext; write lands at that context", () => {
      const wl = buildWorklist();
      const observedContexts: unknown[] = [];
      const p = makeAnalysis<number, number>({
        name: "p",
        storeAlgebra: intMax,
      });
      // Replace transfer to read currentContext and yield a fixed value.
      const pWithTransfer: Analysis<number, number> = {
        ...p,
        storeAlgebra: p.storeAlgebra,
        transfer: (ctx, _k) => {
          observedContexts.push(ctx.currentContext);
          return 7;
        },
      };
      wl.register(pWithTransfer);

      const pHandle = {
        id: Symbol("p-handle"),
        debugName: "p-handle",
        eq: (a: number, b: number) => a === b,
      };
      const ctx = extendContext(ROOT_CONTEXT, pHandle, 42, 99);
      wl.enqueue(pWithTransfer, 42, ctx);
      wl.drain();

      expect(observedContexts).toEqual([ctx]);
      expect(wl.read(pWithTransfer, 42, ctx)).toBe(7);
      expect(wl.read(pWithTransfer, 42, ROOT_CONTEXT)).toBe(0);
    });

    test("wake-ups from a non-ROOT write re-enqueue in the same context", () => {
      const wl = buildWorklist();
      const producer = makeAnalysis<number, number>({
        name: "producer",
        storeAlgebra: intMax,
      });
      const seenContexts: unknown[] = [];
      const reader: Analysis<number, number> = defineAnalysis({
        id: Symbol("reader"),
        debugName: "reader",
        storeAlgebra: intMax,
        edges: [{ on: "fact", analysis: producer, wake: (_c, k) => [k as number] }],
        tier: "analysis",
        polarity: "may",
        transfer: (ctx, _k) => {
          seenContexts.push(ctx.currentContext);
          return undefined;
        },
      });
      wl.register(producer);
      wl.register(reader);

      const producerHandle = {
        id: Symbol("producer-handle"),
        debugName: "producer-handle",
        eq: (a: number, b: number) => a === b,
      };
      const ctx = extendContext(ROOT_CONTEXT, producerHandle, 1, 99);

      // Seed reader so it's considered a known cell target.
      wl.write(reader, 1, 0, ctx);
      seenContexts.length = 0;

      wl.write(producer, 1, 5, ctx);
      wl.drain();

      expect(seenContexts).toEqual([ctx]);
    });

    test("writes at ROOT and non-ROOT do not cross-wake each other", () => {
      const wl = buildWorklist();
      const producer = makeAnalysis<number, number>({
        name: "producer",
        storeAlgebra: intMax,
      });
      const rootSeen: unknown[] = [];
      const reader: Analysis<number, number> = defineAnalysis({
        id: Symbol("reader"),
        debugName: "reader",
        storeAlgebra: intMax,
        edges: [{ on: "fact", analysis: producer, wake: (_c, k) => [k as number] }],
        tier: "analysis",
        polarity: "may",
        transfer: (ctx, _k) => {
          rootSeen.push(ctx.currentContext);
          return undefined;
        },
      });
      wl.register(producer);
      wl.register(reader);

      const producerHandle = {
        id: Symbol("producer-handle"),
        debugName: "producer-handle",
        eq: (a: number, b: number) => a === b,
      };
      const ctx = extendContext(ROOT_CONTEXT, producerHandle, 1, 99);

      wl.write(producer, 1, 5); // ROOT
      wl.drain();
      const afterRoot = rootSeen.slice();

      wl.write(producer, 1, 5, ctx); // non-ROOT
      wl.drain();
      const afterCtx = rootSeen.slice();

      expect(afterRoot.every(c => c === ROOT_CONTEXT)).toBe(true);
      const newCalls = afterCtx.slice(afterRoot.length);
      expect(newCalls.every(c => c === ctx)).toBe(true);
      expect(newCalls.length).toBeGreaterThan(0);
    });
  });
});
