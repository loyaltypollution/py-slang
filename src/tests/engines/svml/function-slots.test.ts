import { StmtNS } from "../../../ast-types";
import { parse } from "../../../parser/parser-adapter";
import { SvmlSlotTable } from "../../../engines/svml/function-slots";

function parseProgram(code: string): StmtNS.FileInput {
  return parse(code + "\n");
}

describe("SvmlSlotTable", () => {
  it("assigns dense slots 0..N-1 in pre-order AST walk over FunctionDef/Lambda/MultiLambda", () => {
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
    const slots = new SvmlSlotTable(ast);
    const outer = ast.statements[0] as StmtNS.FunctionDef;
    const inner = outer.body[0] as StmtNS.FunctionDef;
    const sibling = ast.statements[1] as StmtNS.FunctionDef;

    expect(slots.slotOfNode(ast)).toBe(0);
    expect(slots.slotOfNode(outer)).toBe(1);
    expect(slots.slotOfNode(inner)).toBe(2);
    expect(slots.slotOfNode(sibling)).toBe(3);
  });

  it("allocates a fresh slot for functions appearing after table construction", () => {
    const ast = parseProgram("def f():\n    return 1");
    const slots = new SvmlSlotTable(ast);
    // AST has 2 function-scope nodes (FileInput + f), so next slot is 2.
    expect(slots.size).toBe(2);

    // Simulate a function added after construction (e.g. via a JIT transform).
    const newFn = parseProgram("def g():\n    return 0").statements[0] as StmtNS.FunctionDef;
    // Lazy allocation on first query.
    expect(slots.slotOf(newFn.id)).toBeUndefined();
    expect(slots.slotOfNode(newFn)).toBe(2);
    expect(slots.slotOf(newFn.id)).toBe(2);
    expect(slots.size).toBe(3);
  });

  it("slotOf returns undefined for unknown functionIds without allocating", () => {
    const ast = parseProgram("x = 1");
    const slots = new SvmlSlotTable(ast);
    expect(slots.slotOf(99999)).toBeUndefined();
    expect(slots.size).toBe(1);
  });
});
