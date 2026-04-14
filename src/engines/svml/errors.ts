import { SVMLBoxType, SVMLType } from "./types";

export class SVMLCompilerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SVMLCompilerError";
  }
}

export class SVMLInterpreterError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SVMLInterpreterError";
  }
}

export class UnsupportedOperandTypeError extends SVMLInterpreterError {
  constructor(operand: string, ...wrongTypes: SVMLType[]) {
    const msg = `TypeError: unsupported operand type(s) for ${operand}: ${wrongTypes.map(t => `'${t}'`).join(" and ")}`;
    super(msg);
  }
}

export class MissingRequiredPositionalError extends SVMLInterpreterError {}
export class TooManyPositionalArgumentsError extends SVMLInterpreterError {}
export class ZeroDivisionError extends SVMLInterpreterError {}
export class ValueError extends SVMLInterpreterError {}

/** Thrown by `GUARD_KIND` when the runtime value doesn't match the kind mask
 *  the speculative pass narrowed to. Caught at the engine boundary
 *  (`PySvmlJitEvaluator` / `PyTieredJitEvaluator`), which forces the
 *  observation widening that triggers a recompile and re-enters `execute()`. */
export class SpeculationViolation extends SVMLInterpreterError {
  constructor(
    readonly nodeId: number,
    readonly witnessedValue: SVMLBoxType,
    readonly witnessedKind: SVMLType,
    readonly expectedMask: number,
  ) {
    super(
      `SpeculationViolation: node ${nodeId} expected kind mask 0x${expectedMask.toString(16)}, got ${witnessedKind}`,
    );
    this.name = "SpeculationViolation";
  }
}
