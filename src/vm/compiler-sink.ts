import { Instruction, SVMFunction, Program } from "./svml-compiler";

// ============================================================================
// Instruction Sink Interface for Streaming Compilation
// ============================================================================

/**
 * Interface for streaming instruction output
 * Allows compilation to stream directly to assembler or buffer
 */
export interface InstructionSink {
  /**
   * Begin compilation of a new function
   */
  beginFunction(functionIndex: number, envSize: number, numArgs: number): void;

  /**
   * Emit a single instruction
   */
  emit(instruction: Instruction): void;

  /**
   * Mark a label at the current position for branch resolution
   */
  markLabel(label: string): void;

  /**
   * Emit a branch instruction that will be resolved later
   */
  emitBranch(opcode: number, targetLabel: string): void;

  /**
   * End current function compilation and finalize with stack size
   */
  endFunction(maxStackSize: number): void;

  /**
   * Complete program compilation and return final result
   */
  finalize(entryPointIndex: number): Program;
}

/**
 * Buffered sink that collects instructions in memory
 * Good for testing and when you need the full instruction array
 */
export class BufferedInstructionSink implements InstructionSink {
  private functions: Map<number, {
    envSize: number;
    numArgs: number;
    instructions: Instruction[];
    maxStackSize?: number;
    labels: Map<string, number>;
    pendingBranches: Array<{ index: number; targetLabel: string }>;
  }> = new Map();

  private currentFunction: number | null = null;

  beginFunction(functionIndex: number, envSize: number, numArgs: number): void {
    if (this.currentFunction !== null) {
      throw new Error("Cannot begin function while another is in progress");
    }

    this.currentFunction = functionIndex;
    this.functions.set(functionIndex, {
      envSize,
      numArgs,
      instructions: [],
      labels: new Map(),
      pendingBranches: [],
    });
  }

  emit(instruction: Instruction): void {
    if (this.currentFunction === null) {
      throw new Error("No function in progress");
    }

    const func = this.functions.get(this.currentFunction)!;
    func.instructions.push(instruction);
  }

  markLabel(label: string): void {
    if (this.currentFunction === null) {
      throw new Error("No function in progress");
    }

    const func = this.functions.get(this.currentFunction)!;
    func.labels.set(label, func.instructions.length);
  }

  emitBranch(opcode: number, targetLabel: string): void {
    if (this.currentFunction === null) {
      throw new Error("No function in progress");
    }

    const func = this.functions.get(this.currentFunction)!;
    const index = func.instructions.length;
    
    func.pendingBranches.push({ index, targetLabel });
    func.instructions.push([opcode, 0]); // placeholder offset
  }

  endFunction(maxStackSize: number): void {
    if (this.currentFunction === null) {
      throw new Error("No function in progress");
    }

    const func = this.functions.get(this.currentFunction)!;
    func.maxStackSize = maxStackSize;

    // Resolve all pending branches
    for (const { index, targetLabel } of func.pendingBranches) {
      const targetIndex = func.labels.get(targetLabel);
      if (targetIndex === undefined) {
        throw new Error(`Undefined label: ${targetLabel} in function ${this.currentFunction}`);
      }
      
      const offset = targetIndex - (index + 1); // relative to next instruction
      func.instructions[index][1] = offset;
    }

    this.currentFunction = null;
  }

  finalize(entryPointIndex: number): Program {
    // Convert to SVM format
    const svmFunctions: SVMFunction[] = [];
    
    // Ensure functions are in order by index
    const sortedFunctions = Array.from(this.functions.entries())
      .sort(([a], [b]) => a - b);

    for (const [index, func] of sortedFunctions) {
      if (func.maxStackSize === undefined) {
        throw new Error(`Function ${index} was not properly finalized`);
      }

      svmFunctions[index] = [
        func.maxStackSize,
        func.envSize,
        func.numArgs,
        func.instructions,
      ];
    }

    return [entryPointIndex, svmFunctions];
  }

  /**
   * Get instructions for a specific function (for testing)
   */
  getFunctionInstructions(functionIndex: number): Instruction[] | undefined {
    return this.functions.get(functionIndex)?.instructions;
  }

  /**
   * Reset sink for reuse
   */
  reset(): void {
    this.functions.clear();
    this.currentFunction = null;
  }
}

/**
 * Streaming sink that writes directly to assembler
 * Minimizes memory usage for large programs
 */
export class StreamingInstructionSink implements InstructionSink {
  private functions: Array<{
    functionIndex: number;
    envSize: number;
    numArgs: number;
    maxStackSize?: number;
    instructionCount: number;
    labels: Map<string, number>;
    pendingBranches: Array<{ instructionIndex: number; targetLabel: string }>;
  }> = [];

  private currentFunction: number | null = null;
  private onInstructionEmitted?: (functionIndex: number, instruction: Instruction) => void;

  constructor(onInstructionEmitted?: (functionIndex: number, instruction: Instruction) => void) {
    this.onInstructionEmitted = onInstructionEmitted;
  }

  beginFunction(functionIndex: number, envSize: number, numArgs: number): void {
    if (this.currentFunction !== null) {
      throw new Error("Cannot begin function while another is in progress");
    }

    this.currentFunction = functionIndex;
    
    // Ensure functions array is large enough
    while (this.functions.length <= functionIndex) {
      this.functions.push({
        functionIndex: this.functions.length,
        envSize: 0,
        numArgs: 0,
        instructionCount: 0,
        labels: new Map(),
        pendingBranches: [],
      });
    }

    const func = this.functions[functionIndex];
    func.envSize = envSize;
    func.numArgs = numArgs;
    func.instructionCount = 0;
    func.labels.clear();
    func.pendingBranches = [];
  }

  emit(instruction: Instruction): void {
    if (this.currentFunction === null) {
      throw new Error("No function in progress");
    }

    const func = this.functions[this.currentFunction];
    
    // Notify external handler (e.g., assembler)
    if (this.onInstructionEmitted) {
      this.onInstructionEmitted(this.currentFunction, instruction);
    }

    func.instructionCount++;
  }

  markLabel(label: string): void {
    if (this.currentFunction === null) {
      throw new Error("No function in progress");
    }

    const func = this.functions[this.currentFunction];
    func.labels.set(label, func.instructionCount);
  }

  emitBranch(opcode: number, targetLabel: string): void {
    if (this.currentFunction === null) {
      throw new Error("No function in progress");
    }

    const func = this.functions[this.currentFunction];
    const instructionIndex = func.instructionCount;
    
    func.pendingBranches.push({ instructionIndex, targetLabel });
    
    // Emit placeholder - will be resolved in endFunction
    this.emit([opcode, 0]);
  }

  endFunction(maxStackSize: number): void {
    if (this.currentFunction === null) {
      throw new Error("No function in progress");
    }

    const func = this.functions[this.currentFunction];
    func.maxStackSize = maxStackSize;

    // For streaming sink, we can't easily go back and fix branches
    // This would require cooperation with the assembler or a more complex design
    // For now, we'll store the branch resolution info for later processing
    
    this.currentFunction = null;
  }

  finalize(entryPointIndex: number): Program {
    // For a true streaming implementation, this would coordinate with the assembler
    // For now, we'll create a minimal program structure
    
    const svmFunctions: SVMFunction[] = this.functions.map(func => [
      func.maxStackSize ?? 0,
      func.envSize,
      func.numArgs,
      [], // Instructions were streamed, not stored
    ]);

    return [entryPointIndex, svmFunctions];
  }
}

/**
 * Factory for creating instruction sinks
 */
export class InstructionSinkFactory {
  /**
   * Create a buffered sink for testing or when full instructions are needed
   */
  static createBuffered(): BufferedInstructionSink {
    return new BufferedInstructionSink();
  }

  /**
   * Create a streaming sink that calls handler for each instruction
   */
  static createStreaming(
    onInstruction?: (functionIndex: number, instruction: Instruction) => void
  ): StreamingInstructionSink {
    return new StreamingInstructionSink(onInstruction);
  }

  /**
   * Create a sink that integrates with the existing assembler
   */
  static createAssemblerIntegrated(): BufferedInstructionSink {
    // For now, return buffered - true integration would require assembler changes
    return new BufferedInstructionSink();
  }
}

// ============================================================================
// Sink-based Compilation Context
// ============================================================================

/**
 * Compilation context that uses a sink for output
 */
export type SinkCompilationContext = {
  sink: InstructionSink;
  currentFunctionIndex: number | null;
};

/**
 * Helper functions for working with sinks in monadic context
 */
export const withSink = <T>(
  sink: InstructionSink,
  computation: (context: SinkCompilationContext) => T
): T => {
  const context: SinkCompilationContext = {
    sink,
    currentFunctionIndex: null,
  };
  
  return computation(context);
};
