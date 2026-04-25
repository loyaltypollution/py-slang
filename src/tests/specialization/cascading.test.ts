import { StmtNS } from "../../ast-types";
import { parse } from "../../parser/parser-adapter";
import { Worklist } from "../../specialization/framework/worklist";
import { countNodes } from "./harness/ast-stats";
import { setup, setupAndDrain } from "./harness/compile-pipelines";

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
    const stmts = worklist.locate.functionById(ast.id)!.body;

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
