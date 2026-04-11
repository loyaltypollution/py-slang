/**
 * Tests for CSE machine integration with optimization hints.
 *
 * Verifies that:
 * 1. Hints are populated on Context after optimization
 * 2. Hints are accessible during stepping via generateCSEMachineStateStream
 * 3. Missing hints are handled gracefully
 */

import { StmtNS } from "../ast-types";
import { Context } from "../engines/cse/context";
import { generateCSEMachineStateStream } from "../engines/cse/interpreter";
import { parse } from "../parser/parser-adapter";
import { analyzeWithEnvironments } from "../resolver";
import { HintStore, optimize } from "../specialization";

function parseOptimizeAndAttach(code: string): { context: Context; ast: StmtNS.FileInput } {
  const script = code + "\n";
  const ast = parse(script) as StmtNS.FileInput;
  const { errors, environments } = analyzeWithEnvironments(ast, script, 4);
  if (errors.length > 0) throw errors[0];

  const units = optimize(ast, environments);

  const context = new Context(ast);
  if (units.size > 0) {
    const merged = new HintStore();
    for (const unit of units.values()) {
      unit.hints.mergeInto(merged);
    }
    context.runtime.optimizationHints = merged;
  }
  return { context, ast };
}

// ── 1. Hints populated on context ────────────────────────────────────────────

describe("CSE hint visualization: hints on context", () => {
  test("optimization populates hints for assignment with constant expression", () => {
    const { context, ast } = parseOptimizeAndAttach("x = 1 + 2");
    const hints = context.runtime.optimizationHints;
    expect(hints).toBeInstanceOf(HintStore);
    // The HintStore should have been written to during optimization
    expect(hints!.version).toBeGreaterThan(0);
  });

  test("hints contain type info for integer literal", () => {
    const { context, ast } = parseOptimizeAndAttach("x = 42");
    const hints = context.runtime.optimizationHints!;

    // Walk the AST to find the integer literal node
    const assignStmt = ast.statements[0] as StmtNS.Assign;
    const valueExpr = assignStmt.value;

    const hint = hints.get(valueExpr);
    expect(hint).toBeDefined();
    expect(hint!.type).toBeDefined();
  });

  test("hints contain const info for known constant", () => {
    const { context, ast } = parseOptimizeAndAttach("x = 42");
    const hints = context.runtime.optimizationHints!;

    const assignStmt = ast.statements[0] as StmtNS.Assign;
    const valueExpr = assignStmt.value;

    const hint = hints.get(valueExpr);
    expect(hint).toBeDefined();
    expect(hint!.constVal).toBeDefined();
  });

  test("optimization runs without error on multi-statement programs", () => {
    const { context } = parseOptimizeAndAttach("x = 1\ny = x + 2\nz = y * 3");
    expect(context.runtime.optimizationHints).toBeInstanceOf(HintStore);
    expect(context.runtime.optimizationHints!.version).toBeGreaterThan(0);
  });
});

// ── 1b. Nested function scope hints ─────────────────────────────────────────

describe("CSE hint visualization: nested function scopes", () => {
  test("hints are available for nodes inside function bodies", () => {
    const { context, ast } = parseOptimizeAndAttach(
      "def f():\n    return 1 + 2\nf()",
    );
    const hints = context.runtime.optimizationHints;
    expect(hints).toBeInstanceOf(HintStore);

    // Find the FunctionDef's body: the BinOp (1 + 2) inside return
    const funcDef = ast.statements[0] as StmtNS.FunctionDef;
    const returnStmt = funcDef.body[0] as StmtNS.Return;
    const binOp = returnStmt.value!;

    const hint = hints!.get(binOp);
    expect(hint).toBeDefined();
    expect(hint!.type).toBeDefined();
  });

  test("merged hints include both root and function scope entries", () => {
    const { context, ast } = parseOptimizeAndAttach(
      "x = 10\ndef g():\n    return x + 5\ng()",
    );
    const hints = context.runtime.optimizationHints!;
    expect(hints.version).toBeGreaterThan(0);

    // Root scope: the literal 10
    const assignStmt = ast.statements[0] as StmtNS.Assign;
    const rootHint = hints.get(assignStmt.value);
    expect(rootHint).toBeDefined();

    // Function scope: the BinOp (x + 5) inside return
    const funcDef = ast.statements[1] as StmtNS.FunctionDef;
    const returnStmt = funcDef.body[0] as StmtNS.Return;
    const binOp = returnStmt.value!;
    const fnHint = hints.get(binOp);
    expect(fnHint).toBeDefined();
  });
});

// ── 2. Hints accessible during stepping ──────────────────────────────────────

describe("CSE hint visualization: hints during stepping", () => {
  test("yielded state includes hint field", async () => {
    const { context, ast } = parseOptimizeAndAttach("x = 1 + 2");

    const gen = generateCSEMachineStateStream(
      "", context, context.control, context.stash,
      -1, 1000, 4, false,
    );

    let sawHint = false;
    for await (const state of gen) {
      // Every yielded state should have the hint key (possibly undefined)
      expect(state).toHaveProperty("hint");
      if (state.hint !== undefined) {
        sawHint = true;
      }
    }
    // For `x = 1 + 2`, optimization should produce hints for at least some nodes
    expect(sawHint).toBe(true);
  });

  test("hint includes type or constVal when available", async () => {
    const { context, ast } = parseOptimizeAndAttach("x = 42");

    const gen = generateCSEMachineStateStream(
      "", context, context.control, context.stash,
      -1, 1000, 4, false,
    );

    const hints: Array<{ type?: unknown; constVal?: unknown }> = [];
    for await (const state of gen) {
      if (state.hint) {
        hints.push(state.hint);
      }
    }
    expect(hints.length).toBeGreaterThan(0);
    // At least one hint should have type or constVal info
    const hasInfo = hints.some(h => h.type !== undefined || h.constVal !== undefined);
    expect(hasInfo).toBe(true);
  });
});

// ── 3. Graceful handling without optimization hints ──────────────────────────

describe("CSE hint visualization: no hints", () => {
  test("context without optimizationHints works normally", async () => {
    const script = "x = 1\n";
    const ast = parse(script) as StmtNS.FileInput;
    const { errors } = analyzeWithEnvironments(ast, script, 4);
    expect(errors).toHaveLength(0);

    const context = new Context(ast);
    // Do NOT set optimizationHints — leave undefined

    const gen = generateCSEMachineStateStream(
      "", context, context.control, context.stash,
      -1, 1000, 4, false,
    );

    let stepCount = 0;
    for await (const state of gen) {
      expect(state.hint).toBeUndefined();
      stepCount++;
    }
    expect(stepCount).toBeGreaterThan(0);
  });

  test("optimizationHints field is undefined by default", () => {
    const context = new Context();
    expect(context.runtime.optimizationHints).toBeUndefined();
  });
});
