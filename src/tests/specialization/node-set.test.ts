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

    const unit = worklist.functions.get(ast.id)!;
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

    const root = worklist.functions.get(ast.id)!;
    const fd = ast.statements.find(
      (s): s is StmtNS.FunctionDef => s instanceof StmtNS.FunctionDef,
    )!;
    const nested = worklist.functions.get(fd.id)!;
    const nestedStmt = fd.body[0];
    const defBlock = root.blockOfNode(fd.id)!;

    expect(root.contains(fd.id)).toBe(true);
    expect(defBlock.contains(fd.id)).toBe(true);
    expect(root.contains(nestedStmt.id)).toBe(false);
    expect(defBlock.contains(nestedStmt.id)).toBe(false);
    expect(nested.contains(nestedStmt.id)).toBe(true);
    expect(worklist.functionOfNode(nestedStmt.id)).toBe(nested);
  });
});
