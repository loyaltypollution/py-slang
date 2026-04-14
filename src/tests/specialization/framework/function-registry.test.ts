import { ExprNS, StmtNS } from "../../../ast-types";
import { parse } from "../../../parser/parser-adapter";
import { Resolver } from "../../../resolver";
import {
  FunctionRegistry,
  buildFunctionRegistry,
} from "../../../specialization/framework/function-registry";
import type { FunctionUnit } from "../../../specialization/framework/function-unit";
import type { Pass, WorklistLifecycle } from "../../../specialization/framework/pass";
import { Worklist } from "../../../specialization/framework/worklist";

/** Test helper: a pass that records mint/rebuild/retire events via onRegister. */
function makeLifecycleObserver(): {
  pass: Pass<FunctionUnit, number>;
  minted: FunctionUnit[];
  rebuilt: FunctionUnit[];
  retired: Array<{ unit: FunctionUnit; fdId: number }>;
} {
  const minted: FunctionUnit[] = [];
  const rebuilt: FunctionUnit[] = [];
  const retired: Array<{ unit: FunctionUnit; fdId: number }> = [];
  const pass: Pass<FunctionUnit, number> = {
    id: Symbol("observer"),
    debugName: "observer",
    lattice: { bottom: 0, leq: (a, b) => a <= b, join: Math.max },
    edges: [],
    tier: "analysis",
    transfer: () => undefined,
    onRegister(lifecycle: WorklistLifecycle): void {
      lifecycle.onUnitMinted(u => minted.push(u));
      lifecycle.onUnitRebuilt(u => rebuilt.push(u));
      lifecycle.onUnitRetired((u, fdId) => retired.push({ unit: u, fdId }));
    },
  };
  return { pass, minted, rebuilt, retired };
}

function parseProgram(code: string): StmtNS.FileInput {
  return parse(code + "\n") as StmtNS.FileInput;
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
  function build(src: string, extraPasses: Pass<any, any>[] = []): {
    ast: StmtNS.FileInput;
    worklist: Worklist;
  } {
    const ast = parseProgram(src);
    const resolver = new Resolver(src + "\n", ast);
    resolver.resolve(ast);
    const worklist = new Worklist(ast, resolver.functionEnvironments, extraPasses, undefined, []);
    return { ast, worklist };
  }

  it("retire drops the unit and fires onUnitRetired", () => {
    const obs = makeLifecycleObserver();
    const { ast, worklist } = build(
      ["def f():", "    return 1", "def g():", "    return 2"].join("\n"),
      [obs.pass],
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

  it("mint after retire re-materializes a unit and fires onUnitMinted again", () => {
    const obs = makeLifecycleObserver();
    const { ast, worklist } = build(
      ["def f():", "    return 1", "def g():", "    return 2"].join("\n"),
      [obs.pass],
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
