import * as es from "estree";
import OpCodes from "./opcodes";
import { Instruction, Argument, Address } from "./svml-compiler";

// ============================================================================
// Core Monad Types and Operations
// ============================================================================

/**
 * Reader context - read-only configuration and opcodes
 */
export type Reader = {
  opcodes: typeof OpCodes;
};

/**
 * Compiler state - mutable context that gets threaded through compilation
 */
export type CompilerState = {
  maxStackSize: number;
  currentStackDepth: number; // Track current stack depth
  functionCounter: number;
  labelCounter: number;
  // Track loop context for break/continue
  loopStack: Array<{
    type: "for" | "while";
    breakLabels: string[];
    continueLabel: string;
  }>;
};

/**
 * Efficient instruction builder - avoids array concatenation overhead
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
      const offset = targetIndex - (index + 1); // relative to next instruction
      this.instructions[index][1] = offset;
    }

    return [...this.instructions];
  }

  /**
   * Convert this builder to an SVMFunction
   */
  toSVMFunction(stackSize: number, envSize: number, numArgs: number): [number, number, number, Instruction[]] {
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

/**
 * Compilation result
 */
export type CompilationResult<T = void> = {
  value: T;
  maxStackSize: number;
};

/**
 * The compiler monad - threads Reader, State, and Writer through computations
 */
export type CompilerM<T = void> = (
  reader: Reader,
  state: CompilerState,
  builder: InstructionBuilder
) => CompilationResult<T>;

// ============================================================================
// Monad Operations
// ============================================================================

/**
 * Pure value - lifts a value into the monad without side effects
 */
export const pure = <T>(value: T): CompilerM<T> =>
  (reader, state, builder) => ({
    value,
    maxStackSize: 0,
  });

/**
 * Monadic bind - sequences computations and threads context
 */
export const chain = <A, B>(
  ma: CompilerM<A>,
  f: (a: A) => CompilerM<B>
): CompilerM<B> =>
  (reader, state, builder) => {
    const resultA = ma(reader, state, builder);
    state.maxStackSize = Math.max(state.maxStackSize, resultA.maxStackSize);
    
    const resultB = f(resultA.value)(reader, state, builder);
    
    return {
      value: resultB.value,
      maxStackSize: Math.max(resultA.maxStackSize, resultB.maxStackSize),
    };
  };

/**
 * Map over the result value
 */
export const map = <A, B>(f: (a: A) => B, ma: CompilerM<A>): CompilerM<B> =>
  chain(ma, (a) => pure(f(a)));

/**
 * Sequence computations, keeping only the second result
 */
export const then = <A, B>(ma: CompilerM<A>, mb: CompilerM<B>): CompilerM<B> =>
  chain(ma, () => mb);

/**
 * Get the current reader context
 */
export const ask: CompilerM<Reader> = (reader, state, builder) => ({
  value: reader,
  maxStackSize: 0,
});

/**
 * Get the current state
 */
export const getState: CompilerM<CompilerState> = (reader, state, builder) => ({
  value: state,
  maxStackSize: 0,
});

/**
 * Update the state
 */
export const modifyState = (f: (state: CompilerState) => void): CompilerM<void> =>
  (reader, state, builder) => {
    f(state);
    return { value: undefined, maxStackSize: 0 };
  };

/**
 * Emit an instruction and update stack tracking
 * stackEffect: net change to stack depth (positive = push, negative = pop)
 */
export const emit = (instruction: Instruction, stackEffect: number = 0): CompilerM<void> =>
  (reader, state, builder) => {
    builder.emit(instruction);
    
    // Update current stack depth
    state.currentStackDepth += stackEffect;
    
    // Update max stack size if current depth exceeds it
    if (state.currentStackDepth > state.maxStackSize) {
      state.maxStackSize = state.currentStackDepth;
    }
    
    return {
      value: undefined,
      maxStackSize: stackEffect,
    };
  };

/**
 * Emit a nullary instruction
 */
export const emitNullary = (opcode: number, stackEffect: number = 0): CompilerM<void> =>
  emit([opcode], stackEffect);

/**
 * Emit a unary instruction
 */
export const emitUnary = (opcode: number, arg: Argument, stackEffect: number = 0): CompilerM<void> =>
  emit([opcode, arg], stackEffect);

/**
 * Emit a binary instruction
 */
export const emitBinary = (
  opcode: number,
  arg1: Argument,
  arg2: Argument,
  stackEffect: number = 0
): CompilerM<void> =>
  emit([opcode, arg1, arg2], stackEffect);

/**
 * Generate a unique label
 */
export const genLabel = (prefix: string = "L"): CompilerM<string> =>
  (reader, state, builder) => {
    const label = `${prefix}${state.labelCounter++}`;
    return { value: label, maxStackSize: 0 };
  };

/**
 * Mark a position with a label
 */
export const markLabel = (label: string): CompilerM<void> =>
  (reader, state, builder) => {
    builder.markLabel(label);
    return { value: undefined, maxStackSize: 0 };
  };

/**
 * Emit a branch instruction to a label
 */
export const emitBranchTo = (opcode: number, label: string): CompilerM<void> =>
  (reader, state, builder) => {
    builder.emitBranchTo(opcode, label);
    return { value: undefined, maxStackSize: 0 };
  };

/**
 * Run a computation and return max stack size needed
 */
export const withStackTracking = <T>(computation: CompilerM<T>): CompilerM<{ result: T; stackSize: number }> =>
  (reader, state, builder) => {
    const oldMaxStack = state.maxStackSize;
    const oldStackDepth = state.currentStackDepth;
    
    // Reset stack tracking for this computation
    state.maxStackSize = 0;
    state.currentStackDepth = 0;
    
    const result = computation(reader, state, builder);
    const maxStackSize = state.maxStackSize;
    
    // Restore previous state
    state.maxStackSize = Math.max(oldMaxStack, oldStackDepth + maxStackSize);
    state.currentStackDepth = oldStackDepth + state.currentStackDepth;
    
    return {
      value: { result: result.value, stackSize: maxStackSize },
      maxStackSize: maxStackSize,
    };
  };

// ============================================================================
// Utility Functions for Sequencing
// ============================================================================

/**
 * Sequence an array of computations
 */
export const sequence = <T>(computations: CompilerM<T>[]): CompilerM<T[]> =>
  computations.reduce(
    (acc, comp) => chain(acc, (results) => map((result) => [...results, result], comp)),
    pure([] as T[])
  );

/**
 * Execute computations in sequence, ignoring results
 */
export const sequence_ = (computations: CompilerM<void>[]): CompilerM<void> =>
  computations.reduce((acc, comp) => then(acc, comp), pure(undefined));

// ============================================================================
// Runner Functions
// ============================================================================

/**
 * Create initial compiler state
 */
export const createInitialState = (): CompilerState => ({
  maxStackSize: 0,
  currentStackDepth: 0,
  functionCounter: 0,
  labelCounter: 0,
  loopStack: [],
});

/**
 * Create reader context
 */
export const createReader = (): Reader => ({
  opcodes: OpCodes,
});

/**
 * Run a compilation computation
 */
export const runCompilerM = <T>(
  computation: CompilerM<T>,
  reader: Reader = createReader(),
  state: CompilerState = createInitialState()
): { result: T; instructions: Instruction[]; maxStackSize: number } => {
  const builder = new InstructionBuilder();
  const compilationResult = computation(reader, state, builder);
  
  return {
    result: compilationResult.value,
    instructions: builder.build(),
    maxStackSize: state.maxStackSize,
  };
};
