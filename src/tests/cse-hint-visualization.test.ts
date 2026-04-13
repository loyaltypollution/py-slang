/**
 * Tests for CSE machine integration with optimization facts.
 *
 * After PR A (Layer 5), the CSE stepper does not read or yield facts —
 * the visualizer joins facts against the worklist's shared `FactStore`
 * externally by node id. These tests assert that:
 *  1. Optimization populates facts keyed by node id.
 *  2. Facts are reachable for nodes in nested function scopes.
 *  3. The stepper runs cleanly with no fact hookup at all.
 */

import { StmtNS } from "../ast-types";
import { Context } from "../engines/cse/context";
import { generateCSEMachineStateStream } from "../engines/cse/interpreter";
import { parse } from "../parser/parser-adapter";
import { analyzeWithEnvironments } from "../resolver";
import type { FactStore } from "../specialization/framework/fact-store";
import {
  readConstFact,
  readTypeFact,
} from "../specialization/framework/fact-accessors";
import { buildTestWorklist } from "./utils";

function parseOptimizeAndMerge(code: string): {
  context: Context;
  ast: StmtNS.FileInput;
  factStore: FactStore;
} {
  const script = code + "\n";
  const ast = parse(script) as StmtNS.FileInput;
  const { errors, environments } = analyzeWithEnvironments(ast, script, 4);
  if (errors.length > 0) throw errors[0];

  const engine = buildTestWorklist(ast, environments);
  engine.converge();

  const context = new Context(ast);
  return { context, ast, factStore: engine.factStore };
}

function hasAnyFact(factStore: FactStore, id: number): boolean {
  return (
    readTypeFact(factStore, id) !== undefined ||
    readConstFact(factStore, id) !== undefined
  );
}

// ── 1. Facts populated ──────────────────────────────────────────────────────

describe("CSE hint visualization: facts in store", () => {
  test("optimization populates facts for assignment with constant expression", () => {
    const { ast, factStore } = parseOptimizeAndMerge("x = 1 + 2");
    const assign = ast.statements[0] as StmtNS.Assign;
    expect(hasAnyFact(factStore, assign.value.id)).toBe(true);
  });

  test("facts contain type info for integer literal", () => {
    const { ast, factStore } = parseOptimizeAndMerge("x = 42");

    const assignStmt = ast.statements[0] as StmtNS.Assign;
    const valueExpr = assignStmt.value;

    expect(readTypeFact(factStore, valueExpr.id)).toBeDefined();
  });

  test("facts contain const info for known constant", () => {
    const { ast, factStore } = parseOptimizeAndMerge("x = 42");

    const assignStmt = ast.statements[0] as StmtNS.Assign;
    const valueExpr = assignStmt.value;

    expect(readConstFact(factStore, valueExpr.id)).toBeDefined();
  });

  test("optimization runs without error on multi-statement programs", () => {
    const { ast, factStore } = parseOptimizeAndMerge("x = 1\ny = x + 2\nz = y * 3");
    const assign0 = ast.statements[0] as StmtNS.Assign;
    expect(hasAnyFact(factStore, assign0.value.id)).toBe(true);
  });
});

// ── 2. Nested function scope facts ───────────────────────────────────────────

describe("CSE hint visualization: nested function scopes", () => {
  test("facts are available for nodes inside function bodies", () => {
    const { ast, factStore } = parseOptimizeAndMerge("def f():\n    return 1 + 2\nf()");

    const funcDef = ast.statements[0] as StmtNS.FunctionDef;
    const returnStmt = funcDef.body[0] as StmtNS.Return;
    const binOp = returnStmt.value!;

    expect(readTypeFact(factStore, binOp.id)).toBeDefined();
  });

  test("merged facts include both root and function scope entries", () => {
    const { ast, factStore } = parseOptimizeAndMerge("x = 10\ndef g():\n    return x + 5\ng()");

    const assignStmt = ast.statements[0] as StmtNS.Assign;
    expect(hasAnyFact(factStore, assignStmt.value.id)).toBe(true);

    const funcDef = ast.statements[1] as StmtNS.FunctionDef;
    const returnStmt = funcDef.body[0] as StmtNS.Return;
    const binOp = returnStmt.value!;
    expect(hasAnyFact(factStore, binOp.id)).toBe(true);
  });
});

// ── 3. Stepper joins facts externally by current node id ─────────────────────

describe("CSE hint visualization: external lookup during stepping", () => {
  test("at least one step has a current node whose fact is in the store", async () => {
    const { context, factStore } = parseOptimizeAndMerge("x = 1 + 2");

    const gen = generateCSEMachineStateStream(
      "",
      context,
      context.control,
      context.stash,
      -1,
      1000,
      4,
      false,
    );

    let sawFact = false;
    for await (const _state of gen) {
      const currentNode = context.runtime.nodes[0];
      if (
        currentNode &&
        "id" in currentNode &&
        typeof currentNode.id === "number" &&
        hasAnyFact(factStore, currentNode.id)
      ) {
        sawFact = true;
      }
    }
    expect(sawFact).toBe(true);
  });

  test("fact lookup yields type or constVal when available", async () => {
    const { context, factStore } = parseOptimizeAndMerge("x = 42");

    const gen = generateCSEMachineStateStream(
      "",
      context,
      context.control,
      context.stash,
      -1,
      1000,
      4,
      false,
    );

    const hits: Array<{ type?: unknown; constVal?: unknown }> = [];
    for await (const _state of gen) {
      const currentNode = context.runtime.nodes[0];
      if (currentNode && "id" in currentNode && typeof currentNode.id === "number") {
        const type = readTypeFact(factStore, currentNode.id);
        const constVal = readConstFact(factStore, currentNode.id);
        if (type !== undefined || constVal !== undefined) {
          hits.push({ type, constVal });
        }
      }
    }
    expect(hits.length).toBeGreaterThan(0);
    const hasInfo = hits.some(h => h.type !== undefined || h.constVal !== undefined);
    expect(hasInfo).toBe(true);
  });
});

// ── 4. Graceful handling with no optimization ────────────────────────────────

describe("CSE hint visualization: no facts", () => {
  test("stepper runs cleanly when no fact store is attached", async () => {
    const script = "x = 1\n";
    const ast = parse(script) as StmtNS.FileInput;
    const { errors } = analyzeWithEnvironments(ast, script, 4);
    expect(errors).toHaveLength(0);

    const context = new Context(ast);

    const gen = generateCSEMachineStateStream(
      "",
      context,
      context.control,
      context.stash,
      -1,
      1000,
      4,
      false,
    );

    let stepCount = 0;
    for await (const _state of gen) stepCount++;
    expect(stepCount).toBeGreaterThan(0);
  });
});
