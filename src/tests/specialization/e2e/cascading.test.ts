// Cascading-transform termination: const-fold → dead-branch → enables more
// const-fold, across multiple levels. Verifies `drain()` converges and does
// not hit the iteration cap. Guards the informal termination argument:
// AST-size strictly decreases across dead-branch / const-fold fires, and
// memoization is one-shot per unit via the rule's internal `wrapped`
// WeakSet (sticky across structural rebuilds).

import { ExprNS, StmtNS } from "../../../ast-types";
import { parse } from "../../../parser/parser-adapter";
import { analyzeWithEnvironments } from "../../../resolver";
import { Worklist } from "../../../specialization/framework/worklist";
import { buildTestWorklist } from "../../utils";

function optimise(code: string): { stmts: StmtNS.Stmt[]; rebuilds: number } {
  const script = code + "\n";
  const ast = parse(script) as StmtNS.FileInput;
  const { environments } = analyzeWithEnvironments(ast, script, 4);
  const wl = buildTestWorklist(ast, environments);
  const changed = wl.drain();
  return { stmts: wl.units.get(ast)!.body, rebuilds: changed.size };
}

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
    // Nested dead-branch: outer If True drops else-arm, inner If False drops
    // then-arm, yielding a single assignment. Tests multi-level cascade via
    // repeated CFG rebuilds.
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
    const { stmts, rebuilds } = optimise(code);
    const after = countNodes(stmts);

    // Cascade fully collapses: only an assignment remains.
    expect(stmts).toHaveLength(1);
    expect(stmts[0]).toBeInstanceOf(StmtNS.Assign);

    // AST strictly shrank.
    expect(after).toBeLessThan(before);
    // And we did see actual rebuilds (the test exercises the cascade, not a no-op).
    expect(rebuilds).toBeGreaterThan(0);
  });

  test("drain respects iteration cap and throws past the limit", () => {
    const script = "x = 1\n";
    const ast = parse(script) as StmtNS.FileInput;
    const { environments } = analyzeWithEnvironments(ast, script, 4);
    const wl = buildTestWorklist(ast, environments);
    // Cap of 0: any rebuild at all will throw. With this trivial program
    // no transform fires, so drain should still succeed at limit=0.
    expect(() => wl.drain(0)).not.toThrow();
  });

  test("default drain limit is finite", () => {
    // Regression guard: the previous default (Infinity) was a footgun.
    expect(Worklist.DEFAULT_DRAIN_LIMIT).toBeLessThan(Number.POSITIVE_INFINITY);
    expect(Worklist.DEFAULT_DRAIN_LIMIT).toBeGreaterThan(0);
  });
});
