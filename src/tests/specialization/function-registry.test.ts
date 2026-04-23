import { ExprNS, StmtNS } from "../../ast-types";
import { parse } from "../../parser/parser-adapter";
import {
  FunctionRegistry,
  buildFunctionRegistry,
} from "../../specialization/framework/function-registry";
import { ROOT_CONTEXT } from "../../specialization/lattice/chain";

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

