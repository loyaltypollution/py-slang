/**
 * Core types for the SVML (Source Virtual Machine Language) compiler
 */

export type Offset = number; // instructions to skip
export type Address = [
  number, // function index
  number? // instruction index within function; optional
];
export type Instruction = [
  number, // opcode
  Argument?,
  Argument?
];
export type Argument = number | boolean | string | Offset | Address;
export type SVMFunction = [
  number, // stack size
  number, // environment size
  number, // number of arguments
  Instruction[] // code
];
export type SVMProgram = [
  number, // index of entry point function
  SVMFunction[]
];

/**
 * Efficient instruction builder for generating SVML bytecode
 */
export class InstructionBuilder {
  private instructions: Instruction[] = [];
  private labels: Map<string, number> = new Map();
  private fixups: Array<{ index: number; label: string }> = [];

  emit(instruction: Instruction): void {
    this.instructions.push(instruction);
  }

  emitNullary(opcode: number): void {
    this.emit([opcode]);
  }

  emitUnary(opcode: number, arg: Argument): void {
    this.emit([opcode, arg]);
  }

  emitBinary(opcode: number, arg1: Argument, arg2: Argument): void {
    this.emit([opcode, arg1, arg2]);
  }

  /**
   * Emit a branch instruction that will be fixed up later
   */
  emitBranchTo(opcode: number, label: string): void {
    const index = this.instructions.length;
    this.fixups.push({ index, label });
    this.emit([opcode, 0]); // placeholder offset
  }

  /**
   * Mark current position with a label
   */
  markLabel(label: string): void {
    this.labels.set(label, this.instructions.length);
  }

  /**
   * Get current instruction index (useful for calculating offsets)
   */
  getCurrentIndex(): number {
    return this.instructions.length;
  }

  /**
   * Build final instruction array with all fixups resolved
   */
  build(): Instruction[] {
    // Resolve all branch fixups
    for (const { index, label } of this.fixups) {
      const targetIndex = this.labels.get(label);
      if (targetIndex === undefined) {
        throw new Error(`Undefined label: ${label}`);
      }
      const offset = targetIndex - index; // relative to next instruction
      this.instructions[index][1] = offset;
    }

    return [...this.instructions];
  }

  /**
   * Convert this builder to an SVMFunction
   */
  toSVMFunction(stackSize: number, envSize: number, numArgs: number): SVMFunction {
    return [stackSize, envSize, numArgs, this.build()];
  }

  /**
   * Reset builder for reuse
   */
  reset(): void {
    this.instructions = [];
    this.labels.clear();
    this.fixups = [];
  }
}
