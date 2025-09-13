import OpCodes from "./opcodes";

type Argument = number | string;
export interface Instruction {
  opcode: number;
  arg1?: Argument;
  arg2?: Argument;
}

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

// Pre-computed stack effects indexed by opcode for O(1) lookup
const STACK_EFFECTS = new Int16Array(256); // Assuming max 256 opcodes
(() => {
  // Load constant instructions (+1 to stack)
  STACK_EFFECTS[OpCodes.LDCI] = 1;
  STACK_EFFECTS[OpCodes.LGCI] = 1;
  STACK_EFFECTS[OpCodes.LDCF32] = 1;
  STACK_EFFECTS[OpCodes.LGCF32] = 1;
  STACK_EFFECTS[OpCodes.LDCF64] = 1;
  STACK_EFFECTS[OpCodes.LGCF64] = 1;
  STACK_EFFECTS[OpCodes.LDCB0] = 1;
  STACK_EFFECTS[OpCodes.LDCB1] = 1;
  STACK_EFFECTS[OpCodes.LGCB0] = 1;
  STACK_EFFECTS[OpCodes.LGCB1] = 1;
  STACK_EFFECTS[OpCodes.LGCU] = 1;
  STACK_EFFECTS[OpCodes.LGCN] = 1;
  STACK_EFFECTS[OpCodes.LGCS] = 1;

  // Pop instructions (-1 from stack)
  STACK_EFFECTS[OpCodes.POPG] = -1;
  STACK_EFFECTS[OpCodes.POPB] = -1;
  STACK_EFFECTS[OpCodes.POPF] = -1;

  // Binary arithmetic operations (-1, takes 2 operands, produces 1)
  STACK_EFFECTS[OpCodes.ADDG] = -1;
  STACK_EFFECTS[OpCodes.ADDF] = -1;
  STACK_EFFECTS[OpCodes.SUBG] = -1;
  STACK_EFFECTS[OpCodes.SUBF] = -1;
  STACK_EFFECTS[OpCodes.MULG] = -1;
  STACK_EFFECTS[OpCodes.MULF] = -1;
  STACK_EFFECTS[OpCodes.DIVG] = -1;
  STACK_EFFECTS[OpCodes.DIVF] = -1;
  STACK_EFFECTS[OpCodes.MODG] = -1;
  STACK_EFFECTS[OpCodes.MODF] = -1;

  // Comparison operations (-1, takes 2 operands, produces 1)
  STACK_EFFECTS[OpCodes.LTG] = -1;
  STACK_EFFECTS[OpCodes.LTF] = -1;
  STACK_EFFECTS[OpCodes.GTG] = -1;
  STACK_EFFECTS[OpCodes.GTF] = -1;
  STACK_EFFECTS[OpCodes.LEG] = -1;
  STACK_EFFECTS[OpCodes.LEF] = -1;
  STACK_EFFECTS[OpCodes.GEG] = -1;
  STACK_EFFECTS[OpCodes.GEF] = -1;
  STACK_EFFECTS[OpCodes.EQG] = -1;
  STACK_EFFECTS[OpCodes.EQF] = -1;
  STACK_EFFECTS[OpCodes.EQB] = -1;
  STACK_EFFECTS[OpCodes.NEQG] = -1;
  STACK_EFFECTS[OpCodes.NEQF] = -1;
  STACK_EFFECTS[OpCodes.NEQB] = -1;

  // Unary operations (0, takes 1 operand, produces 1)
  STACK_EFFECTS[OpCodes.NOTG] = 0;
  STACK_EFFECTS[OpCodes.NOTB] = 0;
  STACK_EFFECTS[OpCodes.NEGG] = 0;
  STACK_EFFECTS[OpCodes.NEGF] = 0;

  // Load variable instructions (+1 to stack)
  STACK_EFFECTS[OpCodes.LDLG] = 1;
  STACK_EFFECTS[OpCodes.LDLF] = 1;
  STACK_EFFECTS[OpCodes.LDLB] = 1;
  STACK_EFFECTS[OpCodes.LDPG] = 1;
  STACK_EFFECTS[OpCodes.LDPF] = 1;
  STACK_EFFECTS[OpCodes.LDPB] = 1;

  // Store variable instructions (-1 from stack)
  STACK_EFFECTS[OpCodes.STLG] = -1;
  STACK_EFFECTS[OpCodes.STLF] = -1;
  STACK_EFFECTS[OpCodes.STLB] = -1;
  STACK_EFFECTS[OpCodes.STPG] = -1;
  STACK_EFFECTS[OpCodes.STPF] = -1;
  STACK_EFFECTS[OpCodes.STPB] = -1;

  // Array operations
  STACK_EFFECTS[OpCodes.NEWA] = 0; // Takes size, produces array
  STACK_EFFECTS[OpCodes.LDAG] = -1;
  STACK_EFFECTS[OpCodes.LDAB] = -1;
  STACK_EFFECTS[OpCodes.LDAF] = -1;
  STACK_EFFECTS[OpCodes.STAG] = -3;
  STACK_EFFECTS[OpCodes.STAB] = -3;
  STACK_EFFECTS[OpCodes.STAF] = -3;

  // Function operations
  STACK_EFFECTS[OpCodes.NEWC] = 1;
  STACK_EFFECTS[OpCodes.NEWCP] = 1;
  STACK_EFFECTS[OpCodes.NEWCV] = 1;

  // Branch operations
  STACK_EFFECTS[OpCodes.BRT] = -1;
  STACK_EFFECTS[OpCodes.BRF] = -1;
  STACK_EFFECTS[OpCodes.BR] = 0;
  STACK_EFFECTS[OpCodes.JMP] = 0;

  // Return operations
  STACK_EFFECTS[OpCodes.RETG] = -1;
  STACK_EFFECTS[OpCodes.RETF] = -1;
  STACK_EFFECTS[OpCodes.RETB] = -1;
  STACK_EFFECTS[OpCodes.RETU] = 0;
  STACK_EFFECTS[OpCodes.RETN] = 0;

  // Utility operations
  STACK_EFFECTS[OpCodes.DUP] = 1; // Duplicates top of stack
  STACK_EFFECTS[OpCodes.NEWENV] = 0;
  STACK_EFFECTS[OpCodes.POPENV] = 0;

  // No-op
  STACK_EFFECTS[OpCodes.NOP] = 0;
})();

export class FunctionBuilder {
  private children: FunctionBuilder[] = [];
  private instructions: Instruction[] = [];

  // Fast label tracking with numeric IDs
  private labelPositions: number[] = []; // sparse array: labelId -> instruction index
  private fixups: Array<{ instrIndex: number; labelId: number }> = [];

  // Fast metadata tracking
  private maxStackDepth: number = 0;
  private currentStackDepth: number = 0;
  private symbolCount: number = 0;
  private numArgs: number = 0;
  private functionIndex: number;

  constructor(numArgs: number, functionIndex: number) {
    this.numArgs = numArgs;
    this.functionIndex = functionIndex;
  }

  getFunctionIndex(): number {
    return this.functionIndex;
  }

  createChildBuilder(numArgs: number): FunctionBuilder {
    const child = new FunctionBuilder(numArgs, this.functionIndex + 1);
    this.children.push(child);
    return child;
  }

  getAllBuilders(): FunctionBuilder[] {
    return [this, ...this.children.flatMap((child) => child.getAllBuilders())];
  }

  emitNullary(opcode: number): void {
    this.instructions.push({ opcode });
    this.updateStackDepth(opcode);
  }

  emitUnary(opcode: number, arg1: Argument): void {
    this.instructions.push({ opcode, arg1 });
    this.updateStackDepth(opcode);
  }

  emitBinary(opcode: number, arg1: Argument, arg2: Argument): void {
    this.instructions.push({ opcode, arg1, arg2 });
    this.updateStackDepth(opcode);
  }

  private lastLabelId: number = 0;
  private getNextLabelId(): number {
    return this.lastLabelId++;
  }

  emitJump(opcode: number, labelId?: number): number {
    if (labelId === undefined) {
      labelId = this.getNextLabelId();
    }
    const instrIndex = this.instructions.length;
    this.fixups.push({ instrIndex, labelId });
    this.instructions.push({ opcode }); // placeholder
    this.updateStackDepth(opcode);
    return labelId;
  }

  markLabel(labelId?: number): number {
    if (labelId === undefined) {
      labelId = this.getNextLabelId();
    }
    this.labelPositions[labelId] = this.instructions.length;
    return labelId;
  }

  emitPrimitiveCall(
    opcode: number,
    primitiveIndex: number,
    numArgs: number
  ): void {
    // Primitive call: CALLP/CALLTP
    this.instructions.push({ opcode, arg1: primitiveIndex, arg2: numArgs });
    // Primitive calls: -numArgs + 1 (args consumed, result produced)
    this.currentStackDepth = this.currentStackDepth - numArgs + 1;
    if (this.currentStackDepth > this.maxStackDepth) {
      this.maxStackDepth = this.currentStackDepth;
    }
  }

  emitCall(opcode: number, numArgs: number): void {
    // User function call: CALL/CALLT
    this.instructions.push({ opcode, arg1: numArgs });
    // User calls: -(numArgs + 1) + 1 = -numArgs (function + args consumed, result produced)
    this.currentStackDepth = this.currentStackDepth - numArgs;
    if (this.currentStackDepth > this.maxStackDepth) {
      this.maxStackDepth = this.currentStackDepth;
    }
  }

  private updateStackDepth(opcode: number): void {
    this.currentStackDepth += STACK_EFFECTS[opcode];
    if (this.currentStackDepth > this.maxStackDepth) {
      this.maxStackDepth = this.currentStackDepth;
    }
  }

  // Symbol counting (called by compiler when symbols are used)
  noteSymbolUsed(): void {
    this.symbolCount++;
  }

  build(): Instruction[] {
    for (const { instrIndex, labelId } of this.fixups) {
      const targetIndex = this.labelPositions[labelId];
      if (targetIndex === undefined) {
        throw new Error(`Undefined label ID: ${labelId}`);
      }
      // Patch relative offset directly into instruction
      this.instructions[instrIndex].arg1 = targetIndex - instrIndex;
    }

    // Return the same array (no copying for maximum speed)
    return this.instructions;
  }

  /**
   * Convert this builder to an SVMFunction using calculated metadata
   */
  toSVMFunction(): SVMFunction {
    const stackSize = this.maxStackDepth;
    const envSize = this.symbolCount;
    const instructions = this.build();
    return [stackSize, envSize, this.numArgs, instructions];
  }
}
