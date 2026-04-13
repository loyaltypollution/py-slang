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
import { INT_BIT, BOOL_BIT, BoolRef } from "../specialization";
import { typeOf } from "../specialization/runtime/queries/type-of";
import { buildTestUnits } from "./utils";

function compileAndRun(code: string): unknown {
  const script = code + "\n";
  const ast = parse(script);
  const { errors, environments } = analyzeWithEnvironments(ast, script, 4);
  if (errors.length > 0) throw errors[0];
  const { db, units } = buildTestUnits(ast, environments);
  const compiler = SVMLCompiler.fromProgramUnit(ast, environments, units, db);
  const program = compiler.compileProgram(ast);
  return SVMLInterpreter.toJSValue(new SVMLInterpreter(program).execute());
}

// ── [P1] and / or with non-boolean left operand ───────────────────────────────

describe("[P1] and/or with non-boolean left operand", () => {
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

  test("int and: 0 and 1 should return 0 (Python semantics)", () => {
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
  test("ternary result is correct: 5 if True else -3 = 5", () => {
    expect(compileAndRun("5 if True else -3")).toBe(5);
  });

  test("ternary result used in arithmetic: (5 if True else -3) + 1 = 6", () => {
    expect(compileAndRun("(5 if True else -3) + 1")).toBe(6);
  });

  test("ternary result used in comparison: (5 if True else -3) > 0 = True", () => {
    expect(compileAndRun("(5 if True else -3) > 0")).toBe(true);
  });

  test("ternary node is annotated as TOP (precision gap, not a bug)", () => {
    const script = "(5 if True else -3)\n";
    const ast = parse(script);
    const { environments } = analyzeWithEnvironments(ast, script, 4);
    const { db } = buildTestUnits(ast, environments);

    const simpleExpr = ast.statements[0] as any;
    const ternary = simpleExpr.expression;
    const type = db.get(typeOf, ternary.id);
    // Currently TOP (all kinds set). Should be INT_BIT once fixed.
    expect(type.kinds).not.toBe(INT_BIT);
  });
});

// ── [P3] For-loop single-pass body analysis ────────────────────────────────────

describe("[P3] For-loop body type analysis precision", () => {
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

  test("comparison inside for-loop body annotates as BOOL (precision may be imprecise)", () => {
    const script = "acc = 0\nfor i in [1, 2, 3]:\n    acc = acc + i\n    acc > 0\n";
    const ast = parse(script);
    const { environments } = analyzeWithEnvironments(ast, script, 4);
    const { db } = buildTestUnits(ast, environments);

    // The for-loop is stmt[1]. Its body[1] is `acc > 0` (a SimpleExpr).
    const forStmt = ast.statements[1] as any;
    const cmpExpr = forStmt.body[1].expression; // acc > 0
    const type = db.get(typeOf, cmpExpr.id);

    // The comparison should be annotated as BOOL (kind = BOOL_BIT).
    expect(type.kinds).toBe(BOOL_BIT);

    // The loop variable i = TOP propagates through acc + i → INT(Top),
    // so acc > 0 correctly annotates as BOOL(Top) even in a single pass.
    expect(type.boolRef).toBe(BoolRef.Top);
  });
});
