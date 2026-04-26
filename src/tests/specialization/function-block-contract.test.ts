import { setup } from "./harness/compile-pipelines";

const SRC = `
def f(x):
    y = x + 1
    return y

def g(z):
    return z

f(1)
g(2)
`;

describe("Function/BasicBlock invariants — ownership, locator agreement, rebuild semantics", () => {
  test("BasicBlock.unit references the owning Function for every block in the function's CFG", () => {
    const { worklist } = setup(SRC);
    const units = Array.from(worklist.units.values());

    expect(units.length).toBeGreaterThanOrEqual(3); // root + f + g

    for (const unit of units) {
      for (const block of unit.cfg.blocks) {
        expect(block.unit).toBe(unit);
      }
    }
  });

  test("FunctionLocator.blockContaining(n) === unitContainingNode(n)?.blockOfNode(n) for every CFG-owned node", () => {
    const { worklist } = setup(SRC);
    const locator = worklist.locate;

    const allUnits = Array.from(worklist.units.values());
    let checked = 0;
    for (const unit of allUnits) {
      for (const nodeId of unit.nodeToBlock.keys()) {
        const direct = locator.unitContainingNode(nodeId)?.blockOfNode(nodeId);
        const viaLocator = locator.blockContaining(nodeId);
        expect(viaLocator).toBe(direct);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(0);
  });

  test("rebuild replaces BasicBlock instances wholesale; old block references are no longer indexed", () => {
    const { worklist } = setup(SRC);
    const fm = worklist.units;

    // Pick a non-root function so we can pin both per-function and program-wide indexes.
    const target = Array.from(fm.values()).find(u => u.funcAst.kind === "FunctionDef");
    expect(target).toBeDefined();
    const unit = target!;

    const oldBlocks = new Set(unit.cfg.blocks);
    const oldNodeIds = Array.from(unit.nodeToBlock.keys());
    expect(oldNodeIds.length).toBeGreaterThan(0);

    fm.scheduleRebuild(unit);
    expect(fm.flushPendingRebuilds()).toContain(unit);

    for (const block of unit.cfg.blocks) {
      expect(oldBlocks.has(block)).toBe(false);
      expect(block.unit).toBe(unit);
    }

    for (const nodeId of oldNodeIds) {
      const newBlock = unit.blockOfNode(nodeId);
      expect(newBlock).toBeDefined();
      expect(worklist.locate.blockContaining(nodeId)).toBe(newBlock);
    }
  });

});
