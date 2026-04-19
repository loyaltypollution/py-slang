import { ExprNS, StmtNS } from "../../../ast-types";
import { parse } from "../../../parser/parser-adapter";
import { Resolver } from "../../../resolver";
import {
  FunctionRegistry,
  buildFunctionRegistry,
} from "../../../specialization/framework/function-registry";
import type { FunctionUnit } from "../../../specialization/framework/function-unit";
import type { Analysis } from "../../../specialization/framework/analysis";
import { Worklist } from "../../../specialization/framework/worklist";

/** Test helper: an analysis that records mint/rebuild/retire events via onRegister. */
function makeLifecycleObserver(): {
  analysis: Analysis<FunctionUnit, number>;
  minted: FunctionUnit[];
  rebuilt: FunctionUnit[];
  retired: Array<{ unit: FunctionUnit; fdId: number }>;
} {
  const minted: FunctionUnit[] = [];
  const rebuilt: FunctionUnit[] = [];
  const retired: Array<{ unit: FunctionUnit; fdId: number }> = [];
  const analysis: Analysis<FunctionUnit, number> = {
    id: Symbol("observer"),
    debugName: "observer",
    lattice: { bottom: 0, leq: (a, b) => a <= b, join: Math.max, eq: (a, b) => a === b },
    edges: [
      { on: "mint", effect: (_fs, _ctx, u) => { minted.push(u); } },
      { on: "rebuild", effect: (_fs, _ctx, u) => { rebuilt.push(u); } },
      { on: "retire", effect: (_fs, _ctx, u) => {
        const fd = u.funcAst;
        const fdId = fd instanceof StmtNS.FunctionDef ? fd.id : -1;
        retired.push({ unit: u, fdId });
      }},
    ],
    tier: "analysis",
    polarity: "opaque",
    transfer: () => undefined,
  };
  return { analysis, minted, rebuilt, retired };
}

function parseProgram(code: string): StmtNS.FileInput {
  return parse(code + "\n");
}

describe("FunctionRegistry", () => {
  it("mints FileInput then nested functions in pre-order", () => {
    const ast = parseProgram(
      [
        "def outer():",
        "    def inner():",
        "        return 1",
        "    return inner",
        "def sibling():",
        "    return 2",
      ].join("\n"),
    );
    const registry = buildFunctionRegistry(ast);

    expect(registry.size).toBe(4); // FileInput + outer + inner + sibling
    expect(registry.slotOfNode(ast)).toBe(0);

    const slots = Array.from(registry.entries()).map(e => ({
      slot: e.slot,
      kind: e.node.constructor.name,
    }));
    expect(slots).toEqual([
      { slot: 0, kind: "FileInput" },
      { slot: 1, kind: "FunctionDef" }, // outer
      { slot: 2, kind: "FunctionDef" }, // inner (pre-order DFS)
      { slot: 3, kind: "FunctionDef" }, // sibling
    ]);
  });

  it("slotOf and slotOfNode agree", () => {
    const ast = parseProgram("def f():\n    return 1");
    const registry = buildFunctionRegistry(ast);
    const fn = ast.statements[0] as StmtNS.FunctionDef;
    expect(registry.slotOfNode(fn)).toBe(registry.slotOf(fn.id));
  });

  it("mint rejects duplicate registration", () => {
    const ast = parseProgram("x = 1");
    const registry = buildFunctionRegistry(ast);
    expect(() => registry.mint(ast)).toThrow(/already registered/);
  });

  it("retire makes subsequent lookups throw", () => {
    const ast = parseProgram("def f():\n    return 1");
    const registry = buildFunctionRegistry(ast);
    const fn = ast.statements[0] as StmtNS.FunctionDef;
    const fdId = fn.id;
    expect(registry.slotOf(fdId)).toBe(1);
    registry.retire(fdId);
    expect(() => registry.slotOf(fdId)).toThrow(/not registered/);
    expect(registry.has(fdId)).toBe(false);
    expect(registry.hasNode(fn)).toBe(false);
  });

  it("retire does not reuse slot numbers", () => {
    const ast = parseProgram(
      ["def a():", "    return 1", "def b():", "    return 2"].join("\n"),
    );
    const registry = buildFunctionRegistry(ast);
    const a = ast.statements[0] as StmtNS.FunctionDef;
    registry.retire(a.id);

    // Synthesize a fresh FunctionDef-like node by re-parsing; it gets a fresh id.
    const freshAst = parseProgram("def c():\n    return 3");
    const c = freshAst.statements[0] as StmtNS.FunctionDef;
    const newSlot = registry.mint(c);
    expect(newSlot).toBe(3); // next monotonic slot, not 1 (a's old slot)
  });

  it("covers lambdas and multi-lambdas", () => {
    const ast = parseProgram("f = lambda x: x + 1");
    const registry = buildFunctionRegistry(ast);
    // FileInput + Lambda
    expect(registry.size).toBe(2);
    const entries = Array.from(registry.entries());
    expect(entries[1].node).toBeInstanceOf(ExprNS.Lambda);
  });

  it("snapshot returns fdId -> slot map", () => {
    const ast = parseProgram("def f():\n    return 1");
    const registry = buildFunctionRegistry(ast);
    const snap = registry.snapshot();
    const fn = ast.statements[0] as StmtNS.FunctionDef;
    expect(snap.get(ast.id)).toBe(0);
    expect(snap.get(fn.id)).toBe(1);
    expect(snap.size).toBe(2);
  });

  it("empty registry has size 0", () => {
    const registry = new FunctionRegistry();
    expect(registry.size).toBe(0);
    expect(registry.snapshot().size).toBe(0);
  });
});

describe("FunctionRegistry ↔ Worklist listener wiring", () => {
  // Pins the mint/retire → lifecycle-event contract. No production transform
  // mints or retires today, so this is scaffold — but the plumbing must hold
  // before the first caller arrives, otherwise the silent-miscompile failure
  // mode returns.
  function build(src: string, extraAnalyses: Analysis<any, any>[] = []): {
    ast: StmtNS.FileInput;
    worklist: Worklist;
  } {
    const ast = parseProgram(src);
    const resolver = new Resolver(src + "\n", ast);
    resolver.resolve(ast);
    const worklist = new Worklist(ast, resolver.functionEnvironments, extraAnalyses, undefined, []);
    return { ast, worklist };
  }

  it("retire drops the unit and fires onUnitRetired", () => {
    const obs = makeLifecycleObserver();
    const { ast, worklist } = build(
      ["def f():", "    return 1", "def g():", "    return 2"].join("\n"),
      [obs.analysis],
    );
    const g = ast.statements[1] as StmtNS.FunctionDef;

    const gUnit = worklist.units.get(g);
    expect(gUnit).toBeDefined();
    expect(obs.minted).toContain(gUnit);

    worklist.registry.retire(g.id);

    expect(worklist.units.has(g)).toBe(false);
    expect(obs.retired.map(r => r.fdId)).toContain(g.id);
    expect(() => worklist.registry.slotOf(g.id)).toThrow(/not registered/);
  });

  it("retire evicts fact-store cells for number-keyed analyses", async () => {
    const { runtimeWriteAnalysis, runtimeCallAnalysis } = await import(
      "../../../specialization/framework/runtime-analyses"
    );
    const { purityScopeAnalysis } = await import(
      "../../../specialization/purity-analysis/analysis"
    );
    const { ast, worklist } = build(
      ["def f():", "    return 1", "def g():", "    x = 2", "    return x"].join("\n"),
      [runtimeWriteAnalysis, runtimeCallAnalysis, purityScopeAnalysis],
    );
    const g = ast.statements[1] as StmtNS.FunctionDef;
    const gUnit = worklist.units.get(g)!;

    // Seed cells for g's fdId and one of g's node ids.
    const someNodeId = gUnit.blockOfNode.keys().next().value as number;
    worklist.factStore.write(runtimeWriteAnalysis, someNodeId, { kind: "number", value: 7 });
    worklist.factStore.write(runtimeCallAnalysis, g.id, 3);
    worklist.factStore.write(purityScopeAnalysis, g.id, true);

    expect(worklist.factStore.tryRead(runtimeWriteAnalysis, someNodeId)).toBeDefined();
    expect(worklist.factStore.tryRead(runtimeCallAnalysis, g.id)).toBeDefined();
    expect(worklist.factStore.tryRead(purityScopeAnalysis, g.id)).toBeDefined();

    worklist.registry.retire(g.id);

    expect(worklist.factStore.tryRead(runtimeWriteAnalysis, someNodeId)).toBeUndefined();
    expect(worklist.factStore.tryRead(runtimeCallAnalysis, g.id)).toBeUndefined();
    expect(worklist.factStore.tryRead(purityScopeAnalysis, g.id)).toBeUndefined();
  });

  it("mint after retire re-materializes a unit and fires onUnitMinted again", () => {
    const obs = makeLifecycleObserver();
    const { ast, worklist } = build(
      ["def f():", "    return 1", "def g():", "    return 2"].join("\n"),
      [obs.analysis],
    );
    const g = ast.statements[1] as StmtNS.FunctionDef;

    worklist.registry.retire(g.id);
    expect(worklist.units.has(g)).toBe(false);
    const beforeMintCount = obs.minted.length;

    const newSlot = worklist.registry.mint(g);
    const reborn = worklist.units.get(g);
    expect(reborn).toBeDefined();
    expect(reborn!.slot).toBe(newSlot);
    expect(obs.minted.length).toBe(beforeMintCount + 1);
    expect(obs.minted[obs.minted.length - 1]).toBe(reborn);
  });
});
