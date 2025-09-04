import OpCodes from "./opcodes";
import { Instruction } from "./types";

export interface SVMLTransformer {
  transform(instructions: Instruction[]): Instruction[];
}

export class DeadCodeEliminator implements SVMLTransformer {
  transform(instructions: Instruction[]): Instruction[] {
    const stack: Instruction[] = [];

    for (let i = 0; i < instructions.length; i++) {
      const curr = instructions[i];
      const top = stack[stack.length - 1];

      if (top && this.isNonAction(top, curr)) {
        // Found a pair 
        // Remove both by popping the top and not pushing curr
        stack.pop();
      } else {
        stack.push(curr);
      }
    }

    return stack;
  }

  isNonAction(ins1: Instruction, ins2: Instruction): boolean {
    // (LGCU, POPG)
    if (ins1.opcode === OpCodes.LGCU && ins2.opcode === OpCodes.POPG)
      return true;

    // (LGCN, POPG)
    if (ins1.opcode === OpCodes.LGCN && ins2.opcode === OpCodes.POPG)
      return true;

    return false;
  }
}
