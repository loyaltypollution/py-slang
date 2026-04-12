/**
 * Tests for CSE machine integration with optimization hints.
 *
 * After PR A (Layer 5), the CSE stepper does not read or yield hints —
 * the visualizer joins hints against a `HintStore` externally by node id.
 * These tests assert that:
 *  1. Optimization populates hints keyed by node id.
 *  2. Hints are reachable for nodes in nested function scopes.
 *  3. The stepper runs cleanly with no hint hookup at all.
 */

import { StmtNS } from "../ast-types";
import { Context } from "../engines/cse/context";
import { generateCSEMachineStateStream } from "../engines/cse/interpreter";
import { parse } from "../parser/parser-adapter";
import { analyzeWithEnvironments } from "../resolver";
import { HintStore, SpecializationEngine } from "../specialization";

function parseOptimizeAndMerge(code: string): {
  context: Context;
  ast: StmtNS.FileInput;
  merged: HintStore;
} {
  const script = code + "\n";
  const ast = parse(script) as StmtNS.FileInput;
  const { errors, environments } = analyzeWithEnvironments(ast, script, 4);
  if (errors.length > 0) throw errors[0];

  const engine = new SpecializationEngine(ast, environments);
  engine.converge();
  const units = engine.units;

  const merged = new HintStore();
  for (const unit of units.values()) unit.hints.mergeInto(merged);

  const context = new Context(ast);
  return { context, ast, merged };
}

// ── 1. Hints populated on merged store ───────────────────────────────────────

describe("CSE hint visualization: hints in merged store", () => {
  test("optimization populates hints for assignment with constant expression", () => {
    const { merged } = parseOptimizeAndMerge("x = 1 + 2");
    expect(merged.version).toBeGreaterThan(0);
  });

  test("hints contain type info for integer literal", () => {
    const { ast, merged } = parseOptimizeAndMerge("x = 42");

    const assignStmt = ast.statements[0] as StmtNS.Assign;
    const valueExpr = assignStmt.value;

    const hint = merged.get(valueExpr);
    expect(hint).toBeDefined();
    expect(hint!.type).toBeDefined();
  });

  test("hints contain const info for known constant", () => {
    const { ast, merged } = parseOptimizeAndMerge("x = 42");

    const assignStmt = ast.statements[0] as StmtNS.Assign;
    const valueExpr = assignStmt.value;

    const hint = merged.get(valueExpr);
    expect(hint).toBeDefined();
    expect(hint!.constVal).toBeDefined();
  });

  test("optimization runs without error on multi-statement programs", () => {
    const { merged } = parseOptimizeAndMerge("x = 1\ny = x + 2\nz = y * 3");
    expect(merged.version).toBeGreaterThan(0);
  });
});

// ── 2. Nested function scope hints ───────────────────────────────────────────

describe("CSE hint visualization: nested function scopes", () => {
  test("hints are available for nodes inside function bodies", () => {
    const { ast, merged } = parseOptimizeAndMerge(
      "def f():\n    return 1 + 2\nf()",
    );

    const funcDef = ast.statements[0] as StmtNS.FunctionDef;
    const returnStmt = funcDef.body[0] as StmtNS.Return;
    const binOp = returnStmt.value!;

    const hint = merged.get(binOp);
    expect(hint).toBeDefined();
    expect(hint!.type).toBeDefined();
  });

  test("merged hints include both root and function scope entries", () => {
    const { ast, merged } = parseOptimizeAndMerge(
      "x = 10\ndef g():\n    return x + 5\ng()",
    );
    expect(merged.version).toBeGreaterThan(0);

    const assignStmt = ast.statements[0] as StmtNS.Assign;
    const rootHint = merged.get(assignStmt.value);
    expect(rootHint).toBeDefined();

    const funcDef = ast.statements[1] as StmtNS.FunctionDef;
    const returnStmt = funcDef.body[0] as StmtNS.Return;
    const binOp = returnStmt.value!;
    const fnHint = merged.get(binOp);
    expect(fnHint).toBeDefined();
  });
});

// ── 3. Stepper joins hints externally by current node id ─────────────────────

describe("CSE hint visualization: external lookup during stepping", () => {
  test("at least one step has a current node whose hint is in the store", async () => {
    const { context, merged } = parseOptimizeAndMerge("x = 1 + 2");

    const gen = generateCSEMachineStateStream(
      "", context, context.control, context.stash,
      -1, 1000, 4, false,
    );

    let sawHint = false;
    for await (const _state of gen) {
      const currentNode = context.runtime.nodes[0];
      if (
        currentNode &&
        "id" in currentNode &&
        typeof currentNode.id === "number" &&
        merged.getById(currentNode.id) !== undefined
      ) {
        sawHint = true;
      }
    }
    expect(sawHint).toBe(true);
  });

  test("hint lookup yields type or constVal when available", async () => {
    const { context, merged } = parseOptimizeAndMerge("x = 42");

    const gen = generateCSEMachineStateStream(
      "", context, context.control, context.stash,
      -1, 1000, 4, false,
    );

    const hits: Array<{ type?: unknown; constVal?: unknown }> = [];
    for await (const _state of gen) {
      const currentNode = context.runtime.nodes[0];
      if (currentNode && "id" in currentNode && typeof currentNode.id === "number") {
        const hint = merged.getById(currentNode.id);
        if (hint) hits.push(hint);
      }
    }
    expect(hits.length).toBeGreaterThan(0);
    const hasInfo = hits.some(h => h.type !== undefined || h.constVal !== undefined);
    expect(hasInfo).toBe(true);
  });
});

// ── 4. Graceful handling with no optimization ────────────────────────────────

describe("CSE hint visualization: no hints", () => {
  test("stepper runs cleanly when no merged store is attached", async () => {
    const script = "x = 1\n";
    const ast = parse(script) as StmtNS.FileInput;
    const { errors } = analyzeWithEnvironments(ast, script, 4);
    expect(errors).toHaveLength(0);

    const context = new Context(ast);

    const gen = generateCSEMachineStateStream(
      "", context, context.control, context.stash,
      -1, 1000, 4, false,
    );

    let stepCount = 0;
    for await (const _state of gen) stepCount++;
    expect(stepCount).toBeGreaterThan(0);
  });
});
