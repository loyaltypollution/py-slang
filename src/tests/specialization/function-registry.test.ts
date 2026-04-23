import { ExprNS, StmtNS } from "../../ast-types";
import { parse } from "../../parser/parser-adapter";
import {
  FunctionRegistry,
  buildFunctionRegistry,
} from "../../specialization/framework/function-registry";
import { type Analysis } from "../../specialization/framework/analysis";
import type { ObservationChannel } from "../../specialization/framework/observation-channel";
import { Worklist } from "../../specialization/framework/worklist";
import { ROOT_CONTEXT } from "../../specialization/framework/assumption-chain";
import { setupWithAnalyses } from "./harness/compile-pipelines";

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
    expect(() => registry.mint(ast, ROOT_CONTEXT)).toThrow(/already registered/);
  });

  it("retire makes subsequent lookups throw", () => {
    const ast = parseProgram("def f():\n    return 1");
    const registry = buildFunctionRegistry(ast);
    const fn = ast.statements[0] as StmtNS.FunctionDef;
    const functionId = fn.id;
    expect(registry.slotOf(functionId)).toBe(1);
    registry.retire(functionId, ROOT_CONTEXT);
    expect(() => registry.slotOf(functionId)).toThrow(/not registered/);
    expect(registry.has(functionId)).toBe(false);
    expect(registry.hasNode(fn)).toBe(false);
  });

  it("retire does not reuse slot numbers", () => {
    const ast = parseProgram(
      ["def a():", "    return 1", "def b():", "    return 2"].join("\n"),
    );
    const registry = buildFunctionRegistry(ast);
    const a = ast.statements[0] as StmtNS.FunctionDef;
    registry.retire(a.id, ROOT_CONTEXT);

    // Synthesize a fresh FunctionDef-like node by re-parsing; it gets a fresh id.
    const freshAst = parseProgram("def c():\n    return 3");
    const c = freshAst.statements[0] as StmtNS.FunctionDef;
    const newSlot = registry.mint(c, ROOT_CONTEXT);
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

  it("snapshot returns functionId -> slot map", () => {
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
  function build(
    src: string,
    extraAnalyses: Analysis<any, any>[] = [],
    extraChannels: ObservationChannel<any, any>[] = [],
  ): { ast: StmtNS.FileInput; worklist: Worklist } {
    const { ast, worklist } = setupWithAnalyses(src, extraAnalyses, {
      channels: extraChannels,
    });
    return { ast, worklist };
  }

  it("retire evicts cells for functionId analyses and paramKey channels", async () => {
    const { runtimeParamChannel } = await import(
      "../../specialization/framework/runtime-analyses"
    );
    const { paramKey } = await import(
      "../../specialization/framework/key-spaces"
    );
    const { purityScopeAnalysis } = await import(
      "../../specialization/purity-analysis/analysis"
    );
    const { ast, worklist } = build(
      ["def f():", "    return 1", "def g(x):", "    return x"].join("\n"),
      [purityScopeAnalysis],
      [runtimeParamChannel],
    );
    const g = ast.statements[1] as StmtNS.FunctionDef;

    // Seed cells for g's functionId and g's param 0.
    const gParam0 = paramKey(g.id, 0);
    worklist.publish(runtimeParamChannel, gParam0, { kind: "number", value: 7 }, ROOT_CONTEXT);
    worklist.write(purityScopeAnalysis, g.id, true, ROOT_CONTEXT);

    expect(runtimeParamChannel.tryReadAt(ROOT_CONTEXT, gParam0)).toBeDefined();
    expect(worklist.tryRead(purityScopeAnalysis, g.id, ROOT_CONTEXT)).toBeDefined();

    worklist.registry.retire(g.id, ROOT_CONTEXT);

    expect(runtimeParamChannel.tryReadAt(ROOT_CONTEXT, gParam0)).toBeUndefined();
    expect(worklist.tryRead(purityScopeAnalysis, g.id, ROOT_CONTEXT)).toBeUndefined();
  });

  it("retire evicts runtimeCallCounter cells", async () => {
    const { runtimeCallCounter } = await import(
      "../../specialization/framework/runtime-analyses"
    );
    const { ast, worklist } = build(
      ["def f():", "    return 1", "def g():", "    return 2"].join("\n"),
      [],
    );
    // Register the counter so its retire hook is wired. The `build` helper
    // does not accept counters; register manually to keep the helper narrow.
    worklist.registerCounter(runtimeCallCounter);
    const g = ast.statements[1] as StmtNS.FunctionDef;

    worklist.bump(runtimeCallCounter, g.id);
    worklist.bump(runtimeCallCounter, g.id);
    expect(runtimeCallCounter.at(g.id)).toBe(2);

    worklist.registry.retire(g.id, ROOT_CONTEXT);
    expect(runtimeCallCounter.at(g.id)).toBe(0);
  });

});
