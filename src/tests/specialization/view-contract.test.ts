// Pins the three-question contract for the View kinds that exist today.
// Each test ties one invariant to a specific call site so a future drift
// (e.g. someone reintroducing a stringly registry, or letting BasicBlock
// outlive its owning function rebuild) trips here, not in production.

import { setup } from "./harness/compile-pipelines";
import { makeDfaQuery } from "../../specialization";
import { ROOT_CONTEXT } from "../../specialization/assumption/chain";

const SRC = `
def f(x):
    y = x + 1
    return y

def g(z):
    return z

f(1)
g(2)
`;

describe("View contract — invariants pinned across the three questions", () => {
  test("BasicBlock.unit references the owning Function for every block in the function's CFG", () => {
    const { worklist } = setup(SRC);
    const units = Array.from(worklist.functionManager.values());

    expect(units.length).toBeGreaterThanOrEqual(3); // root + f + g

    for (const unit of units) {
      for (const block of unit.cfg.blocks) {
        expect(block.unit).toBe(unit);
      }
    }
  });

  test("FunctionLocator.blockContaining(n) === functionContainingNode(n)?.blockOfNode(n) for every CFG-owned node", () => {
    const { worklist } = setup(SRC);
    const locator = worklist.locate;

    const allUnits = Array.from(worklist.functionManager.values());
    let checked = 0;
    for (const unit of allUnits) {
      for (const nodeId of unit.nodeToBlock.keys()) {
        const direct = locator.functionContainingNode(nodeId)?.blockOfNode(nodeId);
        const viaLocator = locator.blockContaining(nodeId);
        expect(viaLocator).toBe(direct);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(0);
  });

  test("rebuild replaces BasicBlock instances wholesale; old block references are no longer indexed", () => {
    const { worklist } = setup(SRC);
    const fm = worklist.functionManager;

    // Pick a non-root function so we can pin both per-function and program-wide indexes.
    const target = Array.from(fm.values()).find(u => u.funcAst.kind === "FunctionDef");
    expect(target).toBeDefined();
    const unit = target!;

    const oldBlocks = unit.cfg.blocks;
    const oldEntry = unit.cfg.entry;
    const oldNodeIds = Array.from(unit.nodeToBlock.keys());
    expect(oldNodeIds.length).toBeGreaterThan(0);

    fm.schedulePendingRebuild(unit);
    const rebuilt = fm.flushPendingRebuilds();

    expect(rebuilt).toContain(unit);

    // Function reference stays stable; block instances are replaced.
    expect(unit.cfg.entry).not.toBe(oldEntry);
    for (const oldBlock of oldBlocks) {
      expect(unit.cfg.blocks).not.toContain(oldBlock);
    }

    // Index points at the new blocks.
    for (const nodeId of oldNodeIds) {
      const newBlock = unit.blockOfNode(nodeId);
      expect(newBlock).toBeDefined();
      expect(oldBlocks).not.toContain(newBlock);
      expect(newBlock!.unit).toBe(unit);

      // Locator agrees with per-function index post-rebuild.
      expect(worklist.locate.blockContaining(nodeId)).toBe(newBlock);
    }
  });

  test("makeDfaQuery routes speculative reads through the explicit future-dispatch callback (not via worklist back-channel)", () => {
    const { worklist } = setup(SRC);
    worklist.drain();

    let staticCallbackHits = 0;
    let speculativeCallbackHits = 0;
    const speculativeCallback = (_id: number) => {
      speculativeCallbackHits++;
      return ROOT_CONTEXT;
    };
    const staticCallback = (_id: number) => {
      staticCallbackHits++;
      return ROOT_CONTEXT;
    };

    // Static query — callback should never fire on typeOf/constOf.
    const staticQ = makeDfaQuery(worklist.locate, staticCallback);
    const someNodeId = Array.from(worklist.functionManager.values())[0].nodeToBlock.keys().next().value!;
    staticQ.typeOf(someNodeId);
    staticQ.constOf(someNodeId);
    expect(staticCallbackHits).toBe(0);

    // Speculative readers must hit the callback once per call.
    const specQ = makeDfaQuery(worklist.locate, speculativeCallback);
    specQ.speculativeTypeOf(someNodeId);
    specQ.speculativeConstOf(someNodeId);
    expect(speculativeCallbackHits).toBe(2);

    // makeDfaQuery's only program-shape dependency is the explicit locator
    // arg — no hidden Worklist back-channel. Constructing a query that
    // never actually inspects worklist beyond `locate` exercises that.
  });
});
