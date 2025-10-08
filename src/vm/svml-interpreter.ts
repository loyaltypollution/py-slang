import { SVMProgram, SVMFunction, Instruction } from "./types";
import OpCodes from "./opcodes";
import { InstrumentationTracker, createMemoizedWrapper } from "./instrumentation";
import { executePrimitive } from "./sinter-primitives";

/**
 * TypeScript-based SVML Interpreter
 * 
 * This interpreter runs SVML bytecode directly without needing WASM assembly.
 * It integrates seamlessly with instrumentation for memoization and profiling.
 */

/**
 * Runtime value types
 */
type RuntimeValue = 
  | number 
  | boolean 
  | string 
  | null 
  | undefined 
  | Closure
  | RuntimeArray;

interface RuntimeArray {
  type: 'array';
  elements: RuntimeValue[];
}

/**
 * Closure represents a compiled function with its captured environment
 */
interface Closure {
  type: 'closure';
  functionIndex: number;
  parentEnv: Environment | null;
  isMemoized?: boolean;
  memoCache?: Map<string, RuntimeValue>;
}

/**
 * Environment represents a scope with local variables
 */
class Environment {
  private locals: RuntimeValue[];
  private parent: Environment | null;

  constructor(size: number, parent: Environment | null = null) {
    this.locals = new Array(size).fill(undefined);
    this.parent = parent;
  }

  get(slot: number): RuntimeValue {
    if (slot < 0 || slot >= this.locals.length) {
      throw new Error(`Environment slot ${slot} out of bounds (size: ${this.locals.length})`);
    }
    return this.locals[slot];
  }

  set(slot: number, value: RuntimeValue): void {
    if (slot < 0 || slot >= this.locals.length) {
      throw new Error(`Environment slot ${slot} out of bounds (size: ${this.locals.length})`);
    }
    this.locals[slot] = value;
  }

  getParent(level: number): Environment {
    let env: Environment | null = this;
    for (let i = 0; i < level; i++) {
      if (!env.parent) {
        throw new Error(`No parent environment at level ${level}`);
      }
      env = env.parent;
    }
    return env;
  }

  getSize(): number {
    return this.locals.length;
  }
}

/**
 * Call frame for function execution
 */
interface CallFrame {
  closure: Closure;
  pc: number; // Program counter (instruction index)
  env: Environment;
  stack: RuntimeValue[]; // Each frame has its own operand stack!
  returnAddress: number; // Where to return in the caller
  callerFrame: CallFrame | null;
}

/**
 * SVML Interpreter
 */
export class SVMLInterpreter {
  private program: SVMProgram;
  private functions: SVMFunction[];
  private currentFrame: CallFrame | null;
  private instrumentation: InstrumentationTracker | null;
  private globalEnv: Environment;
  private halted: boolean;
  
  // Execution limits for safety
  private maxStackSize: number = 10000;
  private maxCallDepth: number = 1000;
  private callDepth: number = 0;
  
  // Statistics
  private instructionCount: number = 0;
  private maxInstructionLimit: number = 1000000;
  
  // Debug mode
  private debugMode: boolean = false;

  constructor(
    program: SVMProgram, 
    instrumentation?: InstrumentationTracker,
    options?: {
      maxStackSize?: number;
      maxCallDepth?: number;
      maxInstructions?: number;
      debug?: boolean;
    }
  ) {
    this.program = program;
    this.functions = program[1];
    this.currentFrame = null;
    this.instrumentation = instrumentation || null;
    this.globalEnv = new Environment(0);
    this.halted = false;

    if (options) {
      if (options.maxStackSize) this.maxStackSize = options.maxStackSize;
      if (options.maxCallDepth) this.maxCallDepth = options.maxCallDepth;
      if (options.maxInstructions) this.maxInstructionLimit = options.maxInstructions;
      if (options.debug !== undefined) this.debugMode = options.debug;
    }
  }

  /**
   * Debug logging helper
   */
  private debug(message: string): void {
    if (this.debugMode) {
      console.log(`[DEBUG] ${message}`);
    }
  }

  /**
   * Execute the program and return the result
   */
  execute(): RuntimeValue {
    const entryPointIndex = this.program[0];
    const entryFunction = this.functions[entryPointIndex];

    if (!entryFunction) {
      throw new Error(`Entry point function at index ${entryPointIndex} not found`);
    }

    // Create closure for entry point
    const entryClosure: Closure = {
      type: 'closure',
      functionIndex: entryPointIndex,
      parentEnv: null,
    };

    // Create initial frame with its own stack
    const [stackSize, envSize, numArgs, _instructions] = entryFunction;
    const entryEnv = new Environment(envSize, null);
    
    this.currentFrame = {
      closure: entryClosure,
      pc: 0,
      env: entryEnv,
      stack: [], // Each frame gets its own operand stack
      returnAddress: -1,
      callerFrame: null,
    };

    this.callDepth = 1;
    this.halted = false;
    this.instructionCount = 0;

    // Run the interpreter loop
    return this.run();
  }

  /**
   * Main interpreter loop
   */
  private run(): RuntimeValue {
    while (!this.halted && this.currentFrame) {
      // Safety check
      if (this.instructionCount >= this.maxInstructionLimit) {
        throw new Error(`Exceeded maximum instruction limit (${this.maxInstructionLimit})`);
      }
      this.instructionCount++;

      const frame = this.currentFrame;
      const func = this.functions[frame.closure.functionIndex];
      const instructions = func[3];

      if (frame.pc >= instructions.length) {
        throw new Error(`PC ${frame.pc} out of bounds for function ${frame.closure.functionIndex}`);
      }

      const instr = instructions[frame.pc];
      frame.pc++;

      // Execute instruction
      this.executeInstruction(instr);
    }

    // Return top of stack or undefined  
    return this.currentFrame && this.currentFrame.stack.length > 0 
      ? this.currentFrame.stack[this.currentFrame.stack.length - 1] 
      : undefined;
  }

  /**
   * Execute a single instruction
   */
  private executeInstruction(instr: Instruction): void {
    const opcode = instr.opcode;
    
    if (this.debugMode) {
      const opcodeName = OpCodes[opcode] || `UNKNOWN(${opcode})`;
      const stackStr = this.currentFrame!.stack.map(v => JSON.stringify(SVMLInterpreter.toJSValue(v))).join(", ");
      this.debug(`PC=${this.currentFrame!.pc - 1} | ${opcodeName} ${instr.arg1} ${instr.arg2} | Stack: [${stackStr}]`);
    }

    switch (opcode) {
      // Load constant instructions
      case OpCodes.LGCI:
      case OpCodes.LDCI:
        this.push(instr.arg1 as number);
        break;

      case OpCodes.LGCF32:
      case OpCodes.LDCF32:
      case OpCodes.LGCF64:
      case OpCodes.LDCF64:
        this.push(instr.arg1 as number);
        break;

      case OpCodes.LGCB0:
      case OpCodes.LDCB0:
        this.push(false);
        break;

      case OpCodes.LGCB1:
      case OpCodes.LDCB1:
        this.push(true);
        break;

      case OpCodes.LGCU:
        this.push(undefined);
        break;

      case OpCodes.LGCN:
        this.push(null);
        break;

      case OpCodes.LGCS:
        this.push(instr.arg1 as string);
        break;

      // Stack operations
      case OpCodes.POPG:
      case OpCodes.POPB:
      case OpCodes.POPF:
        this.pop();
        break;

      case OpCodes.DUP:
        const top = this.peek();
        this.push(top);
        break;

      // Arithmetic operations
      case OpCodes.ADDG:
      case OpCodes.ADDF:
        this.binaryOp((a, b) => (a as number) + (b as number));
        break;

      case OpCodes.SUBG:
      case OpCodes.SUBF:
        this.binaryOp((a, b) => (a as number) - (b as number));
        break;

      case OpCodes.MULG:
      case OpCodes.MULF:
        this.binaryOp((a, b) => (a as number) * (b as number));
        break;

      case OpCodes.DIVG:
      case OpCodes.DIVF:
        this.binaryOp((a, b) => (a as number) / (b as number));
        break;

      case OpCodes.MODG:
      case OpCodes.MODF:
        this.binaryOp((a, b) => (a as number) % (b as number));
        break;

      // Unary operations
      case OpCodes.NEGG:
      case OpCodes.NEGF:
        this.unaryOp((a) => -(a as number));
        break;

      case OpCodes.NOTG:
      case OpCodes.NOTB:
        this.unaryOp((a) => !a);
        break;

      // Comparison operations
      case OpCodes.LTG:
      case OpCodes.LTF:
        this.binaryOp((a, b) => (a as number) < (b as number));
        break;

      case OpCodes.GTG:
      case OpCodes.GTF:
        this.binaryOp((a, b) => (a as number) > (b as number));
        break;

      case OpCodes.LEG:
      case OpCodes.LEF:
        this.binaryOp((a, b) => (a as number) <= (b as number));
        break;

      case OpCodes.GEG:
      case OpCodes.GEF:
        this.binaryOp((a, b) => (a as number) >= (b as number));
        break;

      case OpCodes.EQG:
      case OpCodes.EQF:
      case OpCodes.EQB:
        this.binaryOp((a, b) => a === b);
        break;

      case OpCodes.NEQG:
      case OpCodes.NEQF:
      case OpCodes.NEQB:
        this.binaryOp((a, b) => a !== b);
        break;

      // Variable operations
      case OpCodes.LDLG:
      case OpCodes.LDLF:
      case OpCodes.LDLB:
        this.loadLocal(instr.arg1 as number);
        break;

      case OpCodes.STLG:
      case OpCodes.STLF:
      case OpCodes.STLB:
        this.storeLocal(instr.arg1 as number);
        break;

      case OpCodes.LDPG:
      case OpCodes.LDPF:
      case OpCodes.LDPB:
        this.loadParent(instr.arg1 as number, instr.arg2 as number);
        break;

      case OpCodes.STPG:
      case OpCodes.STPF:
      case OpCodes.STPB:
        this.storeParent(instr.arg1 as number, instr.arg2 as number);
        break;

      // Control flow
      case OpCodes.BR:
        this.branch(instr.arg1 as number);
        break;

      case OpCodes.BRT:
        this.branchIfTrue(instr.arg1 as number);
        break;

      case OpCodes.BRF:
        this.branchIfFalse(instr.arg1 as number);
        break;

      // Function operations
      case OpCodes.NEWC:
        this.createClosure(instr.arg1 as number);
        break;

      case OpCodes.CALL:
        this.call(instr.arg1 as number, false);
        break;

      case OpCodes.CALLT:
        this.call(instr.arg1 as number, true);
        break;

      case OpCodes.CALLP:
        this.callPrimitive(instr.arg1 as number, instr.arg2 as number, false);
        break;

      case OpCodes.CALLTP:
        this.callPrimitive(instr.arg1 as number, instr.arg2 as number, true);
        break;

      case OpCodes.RETG:
      case OpCodes.RETF:
      case OpCodes.RETB:
        this.return();
        break;

      case OpCodes.RETU:
        this.push(undefined);
        this.return();
        break;

      case OpCodes.RETN:
        this.push(null);
        this.return();
        break;

      // Array operations
      case OpCodes.NEWA:
        this.createArray();
        break;

      case OpCodes.LDAG:
      case OpCodes.LDAB:
      case OpCodes.LDAF:
        this.loadArrayElement();
        break;

      case OpCodes.STAG:
      case OpCodes.STAB:
      case OpCodes.STAF:
        this.storeArrayElement();
        break;

      // Environment operations
      case OpCodes.NEWENV:
        // Usually handled by CALL, but can be no-op here
        break;

      case OpCodes.POPENV:
        // Usually handled by RETG, but can be no-op here
        break;

      case OpCodes.NOP:
        // Do nothing
        break;

      default:
        throw new Error(`Unimplemented opcode: ${opcode} (${OpCodes[opcode] || 'UNKNOWN'})`);
    }
  }

  // ========================================================================
  // Stack Operations
  // ========================================================================

  private push(value: RuntimeValue): void {
    if (!this.currentFrame) {
      throw new Error("No current frame for push");
    }
    if (this.currentFrame.stack.length >= this.maxStackSize) {
      throw new Error(`Stack overflow (max: ${this.maxStackSize})`);
    }
    this.currentFrame.stack.push(value);
  }

  private pop(): RuntimeValue {
    if (!this.currentFrame) {
      throw new Error("No current frame for pop");
    }
    if (this.currentFrame.stack.length === 0) {
      this.debug(`STACK UNDERFLOW! Current frame: ${this.currentFrame.closure.functionIndex}`);
      throw new Error("Stack underflow");
    }
    const value = this.currentFrame.stack.pop()!;
    this.debug(`  Popped: ${JSON.stringify(SVMLInterpreter.toJSValue(value))}`);
    return value;
  }

  private peek(offset: number = 0): RuntimeValue {
    if (!this.currentFrame) {
      throw new Error("No current frame for peek");
    }
    const index = this.currentFrame.stack.length - 1 - offset;
    if (index < 0) {
      throw new Error("Stack underflow on peek");
    }
    return this.currentFrame.stack[index];
  }

  // ========================================================================
  // Arithmetic/Logical Operations
  // ========================================================================

  private binaryOp(op: (a: RuntimeValue, b: RuntimeValue) => RuntimeValue): void {
    const right = this.pop();
    const left = this.pop();
    const result = op(left, right);
    this.push(result);
  }

  private unaryOp(op: (a: RuntimeValue) => RuntimeValue): void {
    const operand = this.pop();
    const result = op(operand);
    this.push(result);
  }

  // ========================================================================
  // Variable Operations
  // ========================================================================

  private loadLocal(slot: number): void {
    if (!this.currentFrame) {
      throw new Error("No current frame");
    }
    const value = this.currentFrame.env.get(slot);
    this.push(value);
  }

  private storeLocal(slot: number): void {
    if (!this.currentFrame) {
      throw new Error("No current frame");
    }
    const value = this.pop();
    this.debug(`[STLG] Storing to slot ${slot}: ${JSON.stringify(SVMLInterpreter.toJSValue(value))}`);
    this.currentFrame.env.set(slot, value);
  }

  private loadParent(slot: number, level: number): void {
    if (!this.currentFrame) {
      throw new Error("No current frame");
    }
    
    this.debug(`[LDPG] Loading from parent env: slot=${slot}, level=${level}`);
    
    try {
      const parentEnv = this.currentFrame.env.getParent(level);
      this.debug(`[LDPG] Parent env has ${parentEnv.getSize()} slots`);
      const value = parentEnv.get(slot);
      this.debug(`[LDPG] Loaded value: ${JSON.stringify(SVMLInterpreter.toJSValue(value))}`);
      this.push(value);
    } catch (e: any) {
      this.debug(`[LDPG] ERROR: ${e.message}`);
      throw e;
    }
  }

  private storeParent(slot: number, level: number): void {
    if (!this.currentFrame) {
      throw new Error("No current frame");
    }
    const value = this.pop();
    const parentEnv = this.currentFrame.env.getParent(level);
    parentEnv.set(slot, value);
  }

  // ========================================================================
  // Control Flow
  // ========================================================================

  private branch(offset: number): void {
    if (!this.currentFrame) {
      throw new Error("No current frame");
    }
    this.currentFrame.pc += offset - 1;
  }

  private branchIfTrue(offset: number): void {
    const condition = this.pop();
    if (condition) {
      this.branch(offset);
    }
  }

  private branchIfFalse(offset: number): void {
    const condition = this.pop();
    if (!condition) {
      this.branch(offset);
    }
  }

  // ========================================================================
  // Function Operations
  // ========================================================================

  private createClosure(functionIndex: number): void {
    if (!this.currentFrame) {
      throw new Error("No current frame");
    }

    // Check if this function should be memoized
    let isMemoized = false;
    if (this.instrumentation) {
      const funcInfo = this.instrumentation.getFunctionByIndex(functionIndex);
      if (funcInfo && funcInfo.needsMemoization) {
        isMemoized = true;
      }
    }

    const closure: Closure = {
      type: 'closure',
      functionIndex,
      parentEnv: this.currentFrame.env,
      isMemoized,
      memoCache: isMemoized ? new Map() : undefined,
    };

    this.push(closure);
  }

  private call(numArgs: number, isTailCall: boolean): void {
    if (!this.currentFrame) {
      throw new Error("No current frame");
    }

    // Check call depth
    if (!isTailCall && this.callDepth >= this.maxCallDepth) {
      throw new Error(`Maximum call depth exceeded (${this.maxCallDepth})`);
    }

    this.debug(`[CALL] numArgs=${numArgs}, stackSize=${this.currentFrame.stack}, isTail=${isTailCall}`);

    // According to SVML spec: Pop N arguments from stack, then pop function
    // Stack should be: [... func arg1 arg2 ... argN] with argN on top
    // After popping args, we get [arg1, arg2, ..., argN]
    const args: RuntimeValue[] = [];
    for (let i = 0; i < numArgs; i++) {
      if (this.currentFrame?.stack.length === 0) {
        throw new Error(`Stack underflow while popping argument ${i}/${numArgs}. Stack was empty.`);
      }
      args.unshift(this.pop());
    }
    
    this.debug(`[CALL] Popped ${numArgs} args, stack now has ${this.currentFrame.stack.length} items`);

    // Pop the function
    if (this.currentFrame?.stack.length === 0) {
      throw new Error(
        `Stack underflow while popping function. ` +
        `After popping ${numArgs} arguments, stack is empty. ` +
        `This means the function was never pushed onto the stack. ` +
        `Check that LDLG/LDPG is being emitted before arguments.`
      );
    }
    
    const func = this.pop();
    this.debug(`[CALL] Popped function: ${JSON.stringify(SVMLInterpreter.toJSValue(func))}`);
    
    if (typeof func !== 'object' || func === null || (func as any).type !== 'closure') {
      throw new Error(`Cannot call non-closure value: ${JSON.stringify(SVMLInterpreter.toJSValue(func))}`);
    }

    const closure = func as Closure;

    // Check memoization
    if (closure.isMemoized && closure.memoCache) {
      const cacheKey = JSON.stringify(args);
      if (closure.memoCache.has(cacheKey)) {
        const cachedResult = closure.memoCache.get(cacheKey)!;
        this.push(cachedResult);
        return;
      }
    }

    // Get the function definition
    const funcDef = this.functions[closure.functionIndex];
    const [stackSize, envSize, expectedArgs, instructions] = funcDef;

    if (numArgs !== expectedArgs) {
      throw new Error(
        `Function expects ${expectedArgs} arguments but got ${numArgs}`
      );
    }

    // Create new environment for the function
    const newEnv = new Environment(envSize, closure.parentEnv);

    // Store arguments in the new environment (first N slots)
    for (let i = 0; i < numArgs; i++) {
      newEnv.set(i, args[i]);
      this.debug(`[CALL] Set env slot ${i} = ${JSON.stringify(SVMLInterpreter.toJSValue(args[i]))}`);
    }
    
    this.debug(`[CALL] Created new env with ${envSize} slots, parent exists: ${closure.parentEnv !== null}`);

    if (isTailCall) {
      // Tail call optimization: reuse current frame
      this.currentFrame.closure = closure;
      this.currentFrame.pc = 0;
      this.currentFrame.env = newEnv;
      // Clear the stack for tail call
      this.currentFrame.stack = [];
    } else {
      // Create new call frame with its own stack
      const newFrame: CallFrame = {
        closure,
        pc: 0,
        env: newEnv,
        stack: [], // New operand stack for this call!
        returnAddress: this.currentFrame.pc,
        callerFrame: this.currentFrame,
      };
      this.currentFrame = newFrame;
      this.callDepth++;
    }

    // Store reference for memoization
    if (closure.isMemoized && closure.memoCache) {
      // We'll cache the result when the function returns
      // For now, mark that we're executing this call
      (this.currentFrame as any).__memoArgs = args;
      (this.currentFrame as any).__memoClosure = closure;
    }
  }

  private callPrimitive(primitiveIndex: number, numArgs: number, isTailCall: boolean): void {
    this.debug(`[CALLP] primitiveIndex=${primitiveIndex}, numArgs=${numArgs}`);
    
    // According to SVML spec: call.p pops N arguments (NO function object)
    // Primitives don't push a function onto the stack
    const args: RuntimeValue[] = [];
    for (let i = 0; i < numArgs; i++) {
      if (this.currentFrame?.stack.length === 0) {
        throw new Error(`Stack underflow in primitive call while popping argument ${i}/${numArgs}`);
      }
      args.unshift(this.pop());
    }

    this.debug(`[CALLP] Calling primitive ${primitiveIndex} with args: ${JSON.stringify(args.map(a => SVMLInterpreter.toJSValue(a)))}`);

    // Execute primitive function
    const result = executePrimitive(primitiveIndex, args);
    this.push(result);
    
    this.debug(`[CALLP] Primitive returned: ${JSON.stringify(SVMLInterpreter.toJSValue(result))}`);
  }

  private return(): void {
    if (!this.currentFrame) {
      throw new Error("No current frame");
    }

    // Pop return value from CURRENT (callee's) stack
    const returnValue = this.pop();
    
    this.debug(`[RETG] Returning value: ${JSON.stringify(SVMLInterpreter.toJSValue(returnValue))}`);

    // Handle memoization
    const memoArgs = (this.currentFrame as any).__memoArgs;
    const memoClosure = (this.currentFrame as any).__memoClosure;
    if (memoArgs && memoClosure && memoClosure.memoCache) {
      const cacheKey = JSON.stringify(memoArgs);
      memoClosure.memoCache.set(cacheKey, returnValue);
    }

    const callerFrame = this.currentFrame.callerFrame;

    if (!callerFrame) {
      // Returning from entry point
      this.halted = true;
      // Leave return value on the entry frame's stack
      this.push(returnValue);
      return;
    }

    // Switch to caller frame
    this.currentFrame = callerFrame;
    this.callDepth--;

    // Push return value onto CALLER's stack
    this.push(returnValue);
    
    this.debug(`[RETG] Pushed return value to caller's stack, size now: ${this.currentFrame.stack.length}`);
  }

  // ========================================================================
  // Array Operations
  // ========================================================================

  private createArray(): void {
    const size = this.pop() as number;
    const arr: RuntimeArray = {
      type: 'array',
      elements: new Array(size).fill(undefined),
    };
    this.push(arr);
  }

  private loadArrayElement(): void {
    const index = this.pop() as number;
    const arr = this.pop();
    
    if (typeof arr !== 'object' || arr === null || (arr as any).type !== 'array') {
      throw new Error("Cannot index non-array value");
    }

    const array = arr as RuntimeArray;
    if (index < 0 || index >= array.elements.length) {
      throw new Error(`Array index ${index} out of bounds (length: ${array.elements.length})`);
    }

    this.push(array.elements[index]);
  }

  private storeArrayElement(): void {
    const value = this.pop();
    const index = this.pop() as number;
    const arr = this.pop();

    if (typeof arr !== 'object' || arr === null || (arr as any).type !== 'array') {
      throw new Error("Cannot index non-array value");
    }

    const array = arr as RuntimeArray;
    if (index < 0 || index >= array.elements.length) {
      throw new Error(`Array index ${index} out of bounds (length: ${array.elements.length})`);
    }

    array.elements[index] = value;
  }

  // ========================================================================
  // Utility Methods
  // ========================================================================

  /**
   * Get execution statistics
   */
  getStats(): {
    instructionCount: number;
    maxCallDepth: number;
    currentStackSize: number;
  } {
    return {
      instructionCount: this.instructionCount,
      maxCallDepth: this.callDepth,
      currentStackSize: this.currentFrame ? this.currentFrame.stack.length : 0,
    };
  }

  /**
   * Get memoization statistics
   */
  getMemoizationStats(): Map<number, { functionIndex: number; cacheSize: number }> {
    const stats = new Map<number, { functionIndex: number; cacheSize: number }>();
    
    // This would require tracking all closures created, which we can add if needed
    // For now, return empty map
    return stats;
  }

  /**
   * Convert runtime value to JavaScript value for display
   */
  static toJSValue(value: RuntimeValue): any {
    if (value === null || value === undefined) {
      return value;
    }
    if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'string') {
      return value;
    }
    if (typeof value === 'object') {
      if ((value as any).type === 'closure') {
        return `<closure:${(value as Closure).functionIndex}>`;
      }
      if ((value as any).type === 'array') {
        return (value as RuntimeArray).elements.map(e => SVMLInterpreter.toJSValue(e));
      }
    }
    return String(value);
  }
}

import { Value, NumberValue, BoolValue, StringValue, UndefinedValue, ErrorValue, pyClosureValue } from "../cse-machine/stash";

export function runSVMLProgram(
  program: SVMProgram,
  instrumentation?: InstrumentationTracker,
  options?: {
    maxStackSize?: number;
    maxCallDepth?: number;
    maxInstructions?: number;
  }
): Value {
  const interpreter = new SVMLInterpreter(program, instrumentation, options);
  const result = interpreter.execute();

  console.log("Interpreter result: ", result);

  // Convert SVML RuntimeValue to CSE-machine Value type
  function convertToValue(val: any): Value {
    if (val === undefined) {
      return { type: "undefined" } as UndefinedValue;
    }
    if (val === null) {
      return { type: "NoneType", value: undefined };
    }
    if (typeof val === "number") {
      return { type: "number", value: val } as NumberValue;
    }
    if (typeof val === "boolean") {
      return { type: "bool", value: val } as BoolValue;
    }
    if (typeof val === "string") {
      return { type: "string", value: val } as StringValue;
    }
    if (typeof val === "object") {
      if (val.type === "closure") {
        return { type: "closure", closure: val } as pyClosureValue;
      }
      if (val.type === "array") {
        // Recursively convert array elements
        return (val.elements || []).map(convertToValue);
      }
    }
    // Fallback: string representation
    return { type: "string", value: String(val) } as StringValue;
  }

  return convertToValue(result);
}

