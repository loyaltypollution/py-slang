import OpCodes from "../../engines/svml/opcodes";
import type { SVMLProgram } from "../../engines/svml/types";

export function allOpcodes(program: SVMLProgram): number[] {
  const result: number[] = [];
  for (const fn of program.functions) {
    for (let i = 0; i < fn.count; i++) {
      result.push(fn.opcodes[i]);
    }
  }
  return result;
}

export function hasOpcode(program: SVMLProgram, opcode: OpCodes): boolean {
  return allOpcodes(program).includes(opcode);
}

// Monomorphic-path assertion. Optimised build selects the specialised opcode
// where the unoptimised baseline uses the generic one. Catches regressions in:
// type analysis → opcode selection.
export function expectSpecialized(
  optimized: SVMLProgram,
  baseline: SVMLProgram,
  specialized: OpCodes,
  generic: OpCodes,
): void {
  expect(hasOpcode(optimized, specialized)).toBe(true);
  expect(hasOpcode(optimized, generic)).toBe(false);
  expect(hasOpcode(baseline, generic)).toBe(true);
}

// Dead-code / const-fold assertion. The named opcode must not appear
// post-optimization (dead branch eliminated, expression folded).
export function expectOpcodeAbsent(program: SVMLProgram, opcode: OpCodes): void {
  expect(hasOpcode(program, opcode)).toBe(false);
}
