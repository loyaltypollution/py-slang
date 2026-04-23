import OpCodes from "../../../engines/svml/opcodes";
import type { SVMLProgram } from "../../../engines/svml/types";
import { compileOptimized, compileUnoptimized, runSvml } from "./compile-pipelines";
import { expectOpcodeAbsent, expectSpecialized, hasOpcode } from "./opcode-assert";

export type OpcodeCheck =
  | { kind: "specialized"; specialized: OpCodes; generic: OpCodes }
  | { kind: "absent"; opcode: OpCodes }
  | { kind: "present"; opcode: OpCodes };

export interface SpecCase {
  /** Source program. */
  code: string;
  /** Opcode assertions applied to the optimized build. */
  checks?: OpcodeCheck[];
}

/**
 * Run a specialization e2e case:
 *   1. Optimized and unoptimized SVML builds execute to equal JS values.
 *   2. Opcode shape assertions fire on the optimized program.
 */
export function runSpecCase(label: string, c: SpecCase): void {
  const opt = compileOptimized(c.code);
  const base = compileUnoptimized(c.code);

  const optRun = runSvml(opt);
  const baseRun = runSvml(base);
  expect(optRun.value).toStrictEqual(baseRun.value);

  for (const check of c.checks ?? []) {
    applyCheck(opt, base, check, label);
  }
}

function applyCheck(
  opt: SVMLProgram,
  base: SVMLProgram,
  check: OpcodeCheck,
  _label: string,
): void {
  switch (check.kind) {
    case "specialized":
      expectSpecialized(opt, base, check.specialized, check.generic);
      return;
    case "absent":
      expectOpcodeAbsent(opt, check.opcode);
      return;
    case "present":
      expect(hasOpcode(opt, check.opcode)).toBe(true);
      return;
  }
}
