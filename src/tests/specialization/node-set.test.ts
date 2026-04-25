import { StmtNS } from "../../ast-types";
import { setup } from "./harness/compile-pipelines";

describe("program NodeSet ownership", () => {
  test("BasicBlock NodeSet excludes nested branch body statements", () => {
    const { ast, worklist } = setup(`
x = True
if x:
    y = 1
else:
    y = 2
z = 3
`);

    const unit = worklist.locate.functionById(ast.id)!;
    const ifStmt = ast.statements.find((s): s is StmtNS.If => s instanceof StmtNS.If)!;
    const thenStmt = ifStmt.body[0];
    const elseStmt = ifStmt.elseBlock![0];
    const ifBlock = unit.blockOfNode(ifStmt.id)!;

    expect(ifBlock.contains(ifStmt.id)).toBe(true);
    expect(ifBlock.contains(ifStmt.condition.id)).toBe(true);
    expect(ifBlock.contains(thenStmt.id)).toBe(false);
    expect(ifBlock.contains(elseStmt.id)).toBe(false);
    expect(unit.blockOfNode(thenStmt.id)).not.toBe(ifBlock);
    expect(unit.blockOfNode(elseStmt.id)).not.toBe(ifBlock);
  });

  test("enclosing function NodeSets exclude nested function body nodes", () => {
    const { ast, worklist } = setup(`
def f():
    x = 1
f()
`);

    const root = worklist.locate.functionById(ast.id)!;
    const fd = ast.statements.find(
      (s): s is StmtNS.FunctionDef => s instanceof StmtNS.FunctionDef,
    )!;
    const nested = worklist.locate.functionById(fd.id)!;
    const nestedStmt = fd.body[0];
    const defBlock = root.blockOfNode(fd.id)!;

    expect(root.contains(fd.id)).toBe(true);
    expect(defBlock.contains(fd.id)).toBe(true);
    expect(root.contains(nestedStmt.id)).toBe(false);
    expect(defBlock.contains(nestedStmt.id)).toBe(false);
    expect(nested.contains(nestedStmt.id)).toBe(true);
    expect(worklist.locate.functionContainingNode(nestedStmt.id)).toBe(nested);
  });

  // Pins the documented hazard on `BasicBlock.nodeIds` and on
  // `Worklist.subscribe`: synthetic blocks (entry, exit, if/loop joins)
  // carry no AST statements and so have an empty NodeSet. Anyone wiring a
  // node-intersection subscription must not use them as `interest`.
  test("synthetic blocks (entry/exit/joins) have empty nodeIds", () => {
    const { ast, worklist } = setup(`
x = True
if x:
    y = 1
else:
    y = 2
z = 3
i = 0
while i < 3:
    i = i + 1
`);

    const unit = worklist.locate.functionById(ast.id)!;
    // Exit block is always synthetic — only ever link-targeted, never has
    // stmts pushed onto it.
    expect(unit.cfg.exit.stmts.length).toBe(0);
    expect(unit.cfg.exit.nodeIds.size).toBe(0);

    // Every block that has no `stmts` (synthetic) must have empty nodeIds;
    // every block that owns at least one stmt must have at least one node.
    for (const block of unit.cfg.blocks) {
      if (block.stmts.length === 0) {
        expect(block.nodeIds.size).toBe(0);
      } else {
        expect(block.nodeIds.size).toBeGreaterThan(0);
      }
    }

    // The if-join and the while loopExit are both synthetic, so the program
    // produces multiple stmts-empty blocks.
    const synthetic = unit.cfg.blocks.filter(b => b.stmts.length === 0);
    expect(synthetic.length).toBeGreaterThanOrEqual(2);
  });
});
