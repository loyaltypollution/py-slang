/**
 * Tests that specialization passes cause the SVML compiler to emit specialized
 * opcodes instead of generic ones.
 *
 * Strategy: compile with and without optimization, extract opcode streams, and
 * assert that generic opcodes are absent (replaced by specialized ones) or that
 * expressions were folded away entirely.
 *
 * Key insight: constant folding eliminates expressions like `3 + 4` before
 * codegen, so testing opcode selection requires programs where types are known
 * but values are not (e.g., loop counters, reassigned variables).
 */
import { parse } from "../parser/parser-adapter";
import { analyzeWithEnvironments } from "../resolver";
import { SVMLCompiler } from "../engines/svml/svml-compiler";
import OpCodes from "../engines/svml/opcodes";
import { SpecializationEngine } from "../specialization";
import type { SVMLProgram } from "../engines/svml/types";

// ── Helpers ─────────────────────────────────────────────────────────────────

function compileOptimized(code: string): SVMLProgram {
  const script = code + "\n";
  const ast = parse(script);
  const { errors, environments } = analyzeWithEnvironments(ast, script, 4);
  if (errors.length > 0) throw errors[0];
  const engine = new SpecializationEngine(ast, environments);
  engine.converge();
  const compiler = SVMLCompiler.fromProgramUnit(ast, environments, engine.units);
  return compiler.compileProgram(ast);
}

function compileUnoptimized(code: string): SVMLProgram {
  const script = code + "\n";
  const ast = parse(script);
  const { errors, environments } = analyzeWithEnvironments(ast, script, 4);
  if (errors.length > 0) throw errors[0];
  const compiler = SVMLCompiler.fromProgram(ast, environments);
  return compiler.compileProgram(ast);
}

/** Collect all opcodes across all functions in a program. */
function allOpcodes(program: SVMLProgram): number[] {
  const result: number[] = [];
  for (const fn of program.functions) {
    for (let i = 0; i < fn.count; i++) {
      result.push(fn.opcodes[i]);
    }
  }
  return result;
}

function hasOpcode(program: SVMLProgram, opcode: OpCodes): boolean {
  return allOpcodes(program).includes(opcode);
}

// ── Opcode selection: loops where type is known but value is not ─────────

describe("Specialization: opcode selection in loops", () => {
  // While loops are the key test case: the loop counter has a known type
  // (int, from `i = 0`) but its value is not constant (changes each iteration),
  // so constant folding cannot eliminate the expression. This isolates the
  // type analysis → opcode selection pathway.

  const WHILE_ADD = `
i = 0
s = 0
while i < 10:
    s = s + i
    i = i + 1
s
`;

  test("optimized while loop: ADDF present, ADDG absent", () => {
    const program = compileOptimized(WHILE_ADD);
    expect(hasOpcode(program, OpCodes.ADDF)).toBe(true);
    expect(hasOpcode(program, OpCodes.ADDG)).toBe(false);
  });

  test("optimized while loop: LTF present, LTG absent", () => {
    const program = compileOptimized(WHILE_ADD);
    expect(hasOpcode(program, OpCodes.LTF)).toBe(true);
    expect(hasOpcode(program, OpCodes.LTG)).toBe(false);
  });

  test("unoptimized while loop: uses generic ADDG and LTG", () => {
    const program = compileUnoptimized(WHILE_ADD);
    expect(hasOpcode(program, OpCodes.ADDG)).toBe(true);
    expect(hasOpcode(program, OpCodes.LTG)).toBe(true);
    expect(hasOpcode(program, OpCodes.ADDF)).toBe(false);
    expect(hasOpcode(program, OpCodes.LTF)).toBe(false);
  });

  test("while with subtraction: SUBF, no SUBG", () => {
    const code = `
i = 10
while i > 0:
    i = i - 1
i
`;
    const program = compileOptimized(code);
    expect(hasOpcode(program, OpCodes.SUBF)).toBe(true);
    expect(hasOpcode(program, OpCodes.SUBG)).toBe(false);
    expect(hasOpcode(program, OpCodes.GTF)).toBe(true);
    expect(hasOpcode(program, OpCodes.GTG)).toBe(false);
  });

  test("while with multiplication: MULF, no MULG", () => {
    const code = `
i = 1
while i < 100:
    i = i * 2
i
`;
    const program = compileOptimized(code);
    expect(hasOpcode(program, OpCodes.MULF)).toBe(true);
    expect(hasOpcode(program, OpCodes.MULG)).toBe(false);
  });

  test("while with modulo: MODF, no MODG", () => {
    const code = `
i = 100
r = 0
while i > 0:
    r = i % 7
    i = i - 1
r
`;
    const program = compileOptimized(code);
    expect(hasOpcode(program, OpCodes.MODF)).toBe(true);
    expect(hasOpcode(program, OpCodes.MODG)).toBe(false);
  });

  test("while with floor division: FLOORDIVF, no FLOORDIVG", () => {
    const code = `
n = 1000
while n > 0:
    n = n // 2
n
`;
    const program = compileOptimized(code);
    expect(hasOpcode(program, OpCodes.FLOORDIVF)).toBe(true);
    expect(hasOpcode(program, OpCodes.FLOORDIVG)).toBe(false);
  });

  test("while with LE comparison: LEF, no LEG", () => {
    const code = `
i = 0
while i <= 10:
    i = i + 1
i
`;
    const program = compileOptimized(code);
    expect(hasOpcode(program, OpCodes.LEF)).toBe(true);
    expect(hasOpcode(program, OpCodes.LEG)).toBe(false);
  });

  test("while with GE comparison: GEF, no GEG", () => {
    const code = `
i = 10
while i >= 0:
    i = i - 1
i
`;
    const program = compileOptimized(code);
    expect(hasOpcode(program, OpCodes.GEF)).toBe(true);
    expect(hasOpcode(program, OpCodes.GEG)).toBe(false);
  });

  test("while with NE comparison: NEQF, no NEQG", () => {
    const code = `
i = 0
while i != 10:
    i = i + 1
i
`;
    const program = compileOptimized(code);
    expect(hasOpcode(program, OpCodes.NEQF)).toBe(true);
    expect(hasOpcode(program, OpCodes.NEQG)).toBe(false);
  });

  test("while with EQ comparison: EQF, no EQG", () => {
    const code = `
i = 0
found = 0
while i < 10:
    if i == 5:
        found = 1
    i = i + 1
found
`;
    const program = compileOptimized(code);
    expect(hasOpcode(program, OpCodes.EQF)).toBe(true);
    expect(hasOpcode(program, OpCodes.EQG)).toBe(false);
  });
});

// ── Unary operators ─────────────────────────────────────────────────────────

describe("Specialization: unary opcode selection", () => {
  test("negation in loop body: NEGF, no NEGG", () => {
    const code = `
i = 5
s = 0
while i > 0:
    s = s + -i
    i = i - 1
s
`;
    const program = compileOptimized(code);
    expect(hasOpcode(program, OpCodes.NEGF)).toBe(true);
    expect(hasOpcode(program, OpCodes.NEGG)).toBe(false);
  });

  test("boolean not on literal: NOTB, no NOTG", () => {
    // `not True` is const-folded, but `not` on a variable with bool type survives
    const code = `
b = True
while b:
    b = not b
b
`;
    const program = compileOptimized(code);
    expect(hasOpcode(program, OpCodes.NOTB)).toBe(true);
    expect(hasOpcode(program, OpCodes.NOTG)).toBe(false);
  });
});

// ── Constant folding: expressions eliminated entirely ───────────────────────

describe("Specialization: constant folding eliminates expressions", () => {
  // When both operands are constant, the entire binary expression is folded
  // to a literal at the AST level. Neither the generic NOR the specialized
  // opcode should appear — the operation doesn't exist in the bytecode.

  test("const + const: neither ADDG nor ADDF emitted", () => {
    const program = compileOptimized("3 + 4");
    expect(hasOpcode(program, OpCodes.ADDG)).toBe(false);
    expect(hasOpcode(program, OpCodes.ADDF)).toBe(false);
  });

  test("const * const: neither MULG nor MULF emitted", () => {
    const program = compileOptimized("3 * 4");
    expect(hasOpcode(program, OpCodes.MULG)).toBe(false);
    expect(hasOpcode(program, OpCodes.MULF)).toBe(false);
  });

  test("const comparison: neither LTG nor LTF emitted", () => {
    const program = compileOptimized("3 < 4");
    expect(hasOpcode(program, OpCodes.LTG)).toBe(false);
    expect(hasOpcode(program, OpCodes.LTF)).toBe(false);
  });

  test("const vars: comparison folded, dead branch eliminated", () => {
    const code = `
x = 3
y = 4
if x > y:
    z = 1
else:
    z = 2
z
`;
    const program = compileOptimized(code);
    // The entire if/else is gone — x > y is const False, so only else branch survives
    expect(hasOpcode(program, OpCodes.GTG)).toBe(false);
    expect(hasOpcode(program, OpCodes.GTF)).toBe(false);
    expect(hasOpcode(program, OpCodes.BRF)).toBe(false);
  });
});

// ── Negative case: unknown types stay generic ───────────────────────────────

describe("Specialization: unknown types remain generic", () => {
  test("function params use generic opcodes (no inter-proc analysis)", () => {
    const code = `
def add(x, y):
    return x + y
add(3, 4)
`;
    const program = compileOptimized(code);
    // Function body uses ADDG because param types are TOP
    expect(hasOpcode(program, OpCodes.ADDG)).toBe(true);
  });

  test("recursive function body stays generic", () => {
    const code = `
def fib(n):
    if n <= 1:
        return n
    return fib(n - 1) + fib(n - 2)
fib(10)
`;
    const program = compileOptimized(code);
    expect(hasOpcode(program, OpCodes.ADDG)).toBe(true);
    expect(hasOpcode(program, OpCodes.SUBG)).toBe(true);
    expect(hasOpcode(program, OpCodes.LEG)).toBe(true);
  });
});
