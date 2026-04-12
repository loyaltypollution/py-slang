/**
 * Tests targeting each finding from the PR3 code review.
 * Purpose: flag off which issues are real vs moot before fixing.
 *
 * [P1] and/or with non-boolean left operand → BRF throws instead of returning value
 * [P2] visitTernaryExpr returns TOP → downstream specialisation loss (correctness still ok)
 * [P3] for-loop single-pass body analysis → boolRef annotations inside body may be imprecise
 */

import { parse } from "../parser/parser-adapter";
import { analyzeWithEnvironments } from "../resolver";
import { SVMLCompiler } from "../engines/svml/svml-compiler";
import { SVMLInterpreter } from "../engines/svml/svml-interpreter";
import {
  INT_BIT,
  BOOL_BIT,
  BoolRef,
} from "../specialization";
import { buildTestWorklist } from "./utils";

function compileAndRun(code: string): unknown {
  const script = code + "\n";
  const ast = parse(script);
  const { errors, environments } = analyzeWithEnvironments(ast, script, 4);
  if (errors.length > 0) throw errors[0];
  const engine = buildTestWorklist(ast, environments);
  engine.converge();
  const units = engine.units;
  const compiler = SVMLCompiler.fromProgramUnit(ast, environments, units);
  const program = compiler.compileProgram(ast);
  return SVMLInterpreter.toJSValue(new SVMLInterpreter(program).execute());
}

// ── [P1] and / or with non-boolean left operand ───────────────────────────────

describe("[P1] and/or with non-boolean left operand", () => {
  // Python: x and y returns x when x is falsy, else y.
  // SVML BRF throws UnsupportedOperandTypeError for non-boolean operands.

  test("boolean and/or: True and False = False (baseline — must pass)", () => {
    expect(compileAndRun("True and False")).toBe(false);
  });

  test("boolean and/or: False or True = True (baseline — must pass)", () => {
    expect(compileAndRun("False or True")).toBe(true);
  });

  test("boolean and/or: True and True = True", () => {
    expect(compileAndRun("True and True")).toBe(true);
  });

  test("boolean and/or: False or False = False", () => {
    expect(compileAndRun("False or False")).toBe(false);
  });

  // Non-boolean short-circuit: Python says 0 and 1 == 0 (returns the falsy operand).
  // SVML currently throws because BRF requires a boolean on the stack.
  test("int and: 0 and 1 should return 0 (Python semantics)", () => {
    // If this throws, the issue is real: non-boolean and/or is not supported.
    expect(compileAndRun("0 and 1")).toBe(0);
  });

  test("int or: 0 or 5 should return 5 (Python semantics)", () => {
    expect(compileAndRun("0 or 5")).toBe(5);
  });

  test("int or: 3 or 5 should return 3 (Python semantics — returns truthy left)", () => {
    expect(compileAndRun("3 or 5")).toBe(3);
  });
});

// ── [P2] Ternary result type: TOP loses downstream specialisation ──────────────

describe("[P2] Ternary result type annotation", () => {
  // visitTernaryExpr annotates result as TOP instead of join(consequent, alternative).
  // Correctness is unaffected (generic opcode gives the same value); only
  // specialisation of downstream ops is lost. These tests confirm correctness.

  test("ternary result is correct: 5 if True else -3 = 5", () => {
    expect(compileAndRun("5 if True else -3")).toBe(5);
  });

  test("ternary result used in arithmetic: (5 if True else -3) + 1 = 6", () => {
    expect(compileAndRun("(5 if True else -3) + 1")).toBe(6);
  });

  test("ternary result used in comparison: (5 if True else -3) > 0 = True", () => {
    expect(compileAndRun("(5 if True else -3) > 0")).toBe(true);
  });

  // Verify that type hints on the ternary node reflect TOP (current behaviour),
  // not join(INT, INT). This confirms the precision gap — not a correctness bug.
  test("ternary node is annotated as TOP (precision gap, not a bug)", () => {
    const script = "(5 if True else -3)\n";
    const ast = parse(script);
    const { environments } = analyzeWithEnvironments(ast, script, 4);
    const engine = buildTestWorklist(ast, environments);
  engine.converge();
  const units = engine.units;
    const rootUnit = units.get(ast)!;

    const simpleExpr = ast.statements[0] as any;
    const ternary = simpleExpr.expression;
    const hint = rootUnit.hints.get(ternary);
    // Currently TOP (all kinds set). Should be INT_BIT once fixed.
    // Flip this expectation to INT_BIT after the fix lands.
    expect(hint?.type?.kinds).not.toBe(INT_BIT);
  });
});

// ── [P3] For-loop single-pass body analysis ────────────────────────────────────

describe("[P3] For-loop body type analysis precision", () => {
  // The for-loop DFA visits the body once with loop-target = TOP.
  // Variables updated only inside the body may receive imprecise boolRef annotations.
  // Currently harmless because: (a) transforms not wired, (b) opcode selection gates
  // only on kind bits (INT/FLOAT/BOOL), not on boolRef refinements.
  // These tests confirm correctness (not precision) of for-loop output.

  test("for-loop accumulator result is correct", () => {
    const code = `
total = 0
for i in [1, 2, 3]:
    total = total + i
total
`;
    expect(compileAndRun(code)).toBe(6);
  });

  test("for-loop with conditional inside gives correct result", () => {
    const code = `
acc = 0
for i in [1, 2, 3, 4]:
    if i > 2:
        acc = acc + i
acc
`;
    expect(compileAndRun(code)).toBe(7);
  });

  // This test checks the boolRef annotation on a comparison inside a for-loop body.
  // With single-pass analysis: acc starts as INT(Zero), so acc > 0 annotates as BOOL(False).
  // That is imprecise (after first iteration acc is positive, acc > 0 is True).
  // Currently no transform uses this annotation, so correctness is unaffected.
  test("comparison inside for-loop body annotates as BOOL (precision may be imprecise)", () => {
    const script = "acc = 0\nfor i in [1, 2, 3]:\n    acc = acc + i\n    acc > 0\n";
    const ast = parse(script);
    const { environments } = analyzeWithEnvironments(ast, script, 4);
    const engine = buildTestWorklist(ast, environments);
  engine.converge();
  const units = engine.units;
    const rootUnit = units.get(ast)!;

    // The for-loop is stmt[1]. Its body[1] is `acc > 0` (a SimpleExpr).
    const forStmt = ast.statements[1] as any;
    const cmpExpr = forStmt.body[1].expression; // acc > 0
    const hint = rootUnit.hints.get(cmpExpr);

    // The comparison should be annotated as BOOL (kind = BOOL_BIT).
    expect(hint?.type?.kinds).toBe(BOOL_BIT);

    // With single-pass: acc=INT(Zero) at body entry, so acc > 0 may annotate as False.
    // Document current behaviour — boolRef is False (imprecise but harmless today).
    // If this starts being used for branch elimination, this test will catch the regression.
    const boolRef = hint?.type?.boolRef;
    // The loop variable i = TOP propagates through acc + i → INT(Top),
    // so acc > 0 correctly annotates as BOOL(Top) even in a single pass.
    // P3 is moot: the one-pass analysis is precise enough here.
    expect(boolRef).toBe(BoolRef.Top);
  });
});
