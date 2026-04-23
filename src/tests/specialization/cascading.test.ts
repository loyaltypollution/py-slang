// Cascading-transform termination: const-fold → dead-branch → enables more
// const-fold, across multiple levels. Verifies `drain()` converges and does
// not hit the iteration cap.

import { StmtNS } from "../../ast-types";
import { parse } from "../../parser/parser-adapter";
import { Worklist } from "../../specialization/framework/worklist";
import { setup, setupAndDrain } from "./harness/compile-pipelines";

function countNodes(stmts: readonly StmtNS.Stmt[]): number {
  let n = 0;
  const walk = (v: unknown): void => {
    if (v === null || typeof v !== "object") return;
    if (typeof (v as { id?: unknown }).id === "number") n++;
    for (const k of Object.keys(v as object)) {
      const child = (v as Record<string, unknown>)[k];
      if (Array.isArray(child)) for (const c of child) walk(c);
      else if (typeof child === "object") walk(child);
    }
  };
  for (const s of stmts) walk(s);
  return n;
}

describe("cascading transform termination", () => {
  test("nested dead-branch cascade converges via multi-level rebuild", () => {
    const code = [
      "if True:",
      "    if False:",
      "        x = 99",
      "    else:",
      "        if True:",
      "            x = 7",
      "        else:",
      "            x = 8",
      "else:",
      "    x = 42",
    ].join("\n");

    const before = countNodes((parse(code + "\n") as StmtNS.FileInput).statements);
    const { ast, worklist } = setupAndDrain(code);
    const stmts = worklist.units.get(ast.id)!.body;

    expect(stmts).toHaveLength(1);
    expect(stmts[0]).toBeInstanceOf(StmtNS.Assign);
    expect(countNodes(stmts)).toBeLessThan(before);
  });

  test("drain respects iteration cap; no-op program succeeds at limit=0", () => {
    const { worklist } = setup("x = 1");
    expect(() => worklist.drain(0)).not.toThrow();
  });

  test("default drain limit is finite", () => {
    expect(Worklist.DEFAULT_DRAIN_LIMIT).toBeLessThan(Number.POSITIVE_INFINITY);
    expect(Worklist.DEFAULT_DRAIN_LIMIT).toBeGreaterThan(0);
  });
});
