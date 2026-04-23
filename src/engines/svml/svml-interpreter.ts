import { pythonMod } from "../cse/utils";
import { UnsupportedOperandTypeError, ZeroDivisionError } from "./errors";
import OpCodes from "./opcodes";
import { executePrimitive } from "./builtins";
import {
  getSVMLType,
  isSVMLObject,
  SVMLArray,
  SVMLBoxType,
  SVMLClosure,
  SVMLEnvironment,
  SVMLIR,
  SVMLIterator,
  SVMLProgram,
  SVMLType,
} from "./types";
import { StmtNS } from "../../ast-types";

const __DEBUG__ =
  typeof (globalThis as Record<string, unknown>).__DEBUG__ !== "undefined" &&
  (globalThis as Record<string, unknown>).__DEBUG__;

/** A Python-numeric runtime value: int (bigint) or float (number). */
function isNumeric(v: SVMLBoxType): v is number | bigint {
  return typeof v === "number" || typeof v === "bigint";
}

/** Coerce a numeric to JS number, losing precision for bigint > 2^53. Used
 *  on the mixed-operand path where Python coerces int → float. */
function toNumber(v: number | bigint): number {
  return typeof v === "bigint" ? Number(v) : v;
}

/** Python `==`: values equal if equal by Python semantics. For ints/floats
 *  this crosses type boundaries (1 == 1.0 → True). JS `==` does the right
 *  thing for number/bigint pairs (1n == 1 → true), but we avoid loose `==`
 *  elsewhere to prevent NaN or string coercion surprises. */
function pythonEqual(left: SVMLBoxType, right: SVMLBoxType): boolean {
  if (isNumeric(left) && isNumeric(right)) {
    // number vs bigint: JS `==` coerces correctly. bigint vs bigint: JS
    // `===` works. number vs number: NaN-aware via `===`.
    if (typeof left === typeof right) return left === right;
    return left == right;
  }
  return left === right;
}
const debug: (msg: string) => void = __DEBUG__ ? (msg: string) => console.log(msg) : () => {};

/**
 * TypeScript-based SVML Interpreter
 *
 * This interpreter runs SVML bytecode directly without needing WASM assembly.
 */

/**
 * Call frame for function execution
 */
interface CallFrame {
  closure: SVMLClosure;
  ir: SVMLIR;
  pc: number;
  env: SVMLEnvironment;
  stack: SVMLBoxType[];
  callerFrame: CallFrame | null;
}

/**
 * SVML Interpreter
 */
export class SVMLInterpreter {
  private program: SVMLProgram;
  private currentFrame: CallFrame | null;
  private globalEnv: SVMLEnvironment;
  private halted: boolean;
  private readonly onOutput: (msg: string) => void;

  // Execution limits for safety
  private maxStackSize: number = 10000;
  private maxCallDepth: number = 1000;
  private callDepth: number = 0;

  private instructionCount: number = 0;
  private maxInstructionLimit: number = 1000000;

  /**
   * JIT dispatch hooks. Symmetric with CSE's `JitHooks.dispatchCall` /
   * `dispatchReturn` surface.
   *
   * `dispatchCall` is atomic at CALL entry: the hook publishes runtime
   * observations (hotness, param kinds), derives a specialized body under
   * the resulting chain, compiles it to fresh SVMLIR, and returns that IR —
   * or `undefined` to signal "use the canonical IR unchanged." The
   * interpreter uses the returned IR directly for this invocation; it does
   * NOT mutate the function table. No caching: compile-per-call.
   *
   * `dispatchReturn` feeds `runtimeReturnChannel` against the chain this
   * call was dispatched under (B1 attribution is automatic because the
   * `dispatchCall` hook's LIFO already pushed the post-observation chain).
   *
   * Defaults are no-ops for standalone bytecode execution (no JIT).
   */
  private dispatchCall:
    | ((scopeId: number, args: readonly SVMLBoxType[]) => SVMLIR | undefined)
    | undefined = undefined;
  private dispatchReturn: (scopeId: number, value: unknown) => void = () => {};

  constructor(
    program: SVMLProgram,
    options?: {
      maxStackSize?: number;
      maxCallDepth?: number;
      maxInstructions?: number;
      sendOutput?: (msg: string) => void;
      dispatchCall?: (scopeId: number, args: readonly SVMLBoxType[]) => SVMLIR | undefined;
      dispatchReturn?: (scopeId: number, value: unknown) => void;
    },
  ) {
    this.program = program;
    this.currentFrame = null;
    this.globalEnv = new SVMLEnvironment(0);
    this.halted = false;
    this.onOutput = options?.sendOutput ?? (() => {});

    if (options) {
      if (options.maxStackSize) this.maxStackSize = options.maxStackSize;
      if (options.maxCallDepth) this.maxCallDepth = options.maxCallDepth;
      if (options.maxInstructions) this.maxInstructionLimit = options.maxInstructions;
      if (options.dispatchCall) this.dispatchCall = options.dispatchCall;
      if (options.dispatchReturn) this.dispatchReturn = options.dispatchReturn;
    }
  }

  /**
   * Replace the program between executions (e.g., after JIT recompilation).
   * Throws if called while the interpreter is mid-execution.
   */
  replaceProgram(newProgram: SVMLProgram): void {
    if (this.currentFrame !== null) {
      throw new Error("Cannot replace program while interpreter is executing");
    }
    this.program = newProgram;
  }

  /**
   * Return the currently installed IR for `index`, or `undefined` if the
   * slot is missing.
   */
  functionAt(index: number): SVMLIR | undefined {
    return this.program.functions[index];
  }

  /**
   * Swap function `index`'s IR. Caller must hold the direct-IR-ref
   * invariant: no `CallFrame.ir` outlives this reassignment, because frames
   * capture IR at CALL time. Expected caller: the evaluator's JIT publish
   * hook after deciding the IR has actually changed.
   */
  patchFunction(index: number, ir: SVMLIR): void {
    this.program = this.program.withSpecializedFunction(index, ir);
  }

  /**
   * Execute the program and return the result
   */
  execute(): SVMLBoxType {
    const entryPointIndex = this.program.entryPoint;
    const entryFunction = this.program.functions[entryPointIndex];

    if (!entryFunction) {
      throw new Error(`Entry point function at index ${entryPointIndex} not found`);
    }

    const entryClosure: SVMLClosure = {
      type: "closure",
      functionIndex: entryPointIndex,
      parentEnv: null,
    };

    const entryEnv = new SVMLEnvironment(entryFunction.envSize, null);

    this.currentFrame = {
      closure: entryClosure,
      ir: entryFunction,
      pc: 0,
      env: entryEnv,
      stack: [],
      callerFrame: null,
    };

    this.callDepth = 1;
    this.halted = false;
    this.instructionCount = 0;

    return this.run();
  }

  /**
   * Main interpreter loop — dispatch from typed arrays
   */
  private run(): SVMLBoxType {
    try {
      return this.runInner();
    } finally {
      // Clear execution state so replaceProgram() can be called between runs,
      // even if runInner threw.
      this.currentFrame = null;
    }
  }

  private runInner(): SVMLBoxType {
    while (!this.halted && this.currentFrame) {
      // Safety check
      if (this.instructionCount >= this.maxInstructionLimit) {
        throw new Error(`Exceeded maximum instruction limit (${this.maxInstructionLimit})`);
      }
      this.instructionCount++;

      const frame = this.currentFrame;
      const ir = frame.ir;

      if (frame.pc >= ir.count) {
        throw new Error(`PC ${frame.pc} out of bounds for function ${frame.closure.functionIndex}`);
      }

      const pc = frame.pc;
      frame.pc++;

      const op = ir.opcodes[pc];
      const a1 = ir.arg1s[pc];
      const a2 = ir.arg2s[pc];

      if (__DEBUG__)
        debug(
          `PC=${pc} | ${OpCodes[op] || `UNKNOWN(${op})`} ${a1} ${a2} | Stack: [${frame.stack.map(v => JSON.stringify(SVMLInterpreter.toJSValue(v))).join(", ")}]`,
        );

      switch (op) {
        // Load constant instructions
        case OpCodes.LGCI:
        case OpCodes.LDCI:
          // Python int → JS bigint. arg1s stores the i32 value; BigInt() the
          // value (not the pool index) lifts it into the Python int domain.
          this.push(BigInt(a1));
          break;

        case OpCodes.LGCF32:
        case OpCodes.LDCF32:
        case OpCodes.LGCF64:
        case OpCodes.LDCF64:
          this.push(a1);
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
          this.push(ir.strings[a1]);
          break;

        // Stack operations
        case OpCodes.POPG:
        case OpCodes.POPB:
        case OpCodes.POPF:
          this.pop();
          break;

        case OpCodes.DUP: {
          const top = this.peek();
          this.push(top);
          break;
        }

        // Arithmetic operations
        //
        // G-variants dispatch on operand kind. Python semantics:
        //   int  op int  → int   (bigint)
        //   float op *   → float (number, mixed operands coerce bigint→number)
        //   `/` is true division and always produces float
        //   `//` and `%` preserve intness only for (int, int)
        //
        // F-variants assume both operands are float. They are emitted by
        // specialized codegen when the type lattice proves FLOAT_BIT on both
        // sides; do not add int logic to them.
        case OpCodes.ADDG: {
          const right = this.pop();
          const left = this.pop();
          if (typeof left === "bigint" && typeof right === "bigint") {
            this.push(left + right);
          } else if (isNumeric(left) && isNumeric(right)) {
            this.push(toNumber(left) + toNumber(right));
          } else if (typeof left === "string" && typeof right === "string") {
            this.push(left + right);
          } else {
            throw new UnsupportedOperandTypeError("+", getSVMLType(left), getSVMLType(right));
          }
          break;
        }
        case OpCodes.ADDF: {
          const right = this.pop() as number;
          const left = this.pop() as number;
          this.push(left + right);
          break;
        }
        case OpCodes.SUBG: {
          const right = this.pop();
          const left = this.pop();
          if (typeof left === "bigint" && typeof right === "bigint") {
            this.push(left - right);
          } else if (isNumeric(left) && isNumeric(right)) {
            this.push(toNumber(left) - toNumber(right));
          } else {
            throw new UnsupportedOperandTypeError("-", getSVMLType(left), getSVMLType(right));
          }
          break;
        }
        case OpCodes.SUBF: {
          const right = this.pop() as number;
          const left = this.pop() as number;
          this.push(left - right);
          break;
        }
        case OpCodes.MULG: {
          const right = this.pop();
          const left = this.pop();
          if (typeof left === "bigint" && typeof right === "bigint") {
            this.push(left * right);
          } else if (isNumeric(left) && isNumeric(right)) {
            this.push(toNumber(left) * toNumber(right));
          } else {
            throw new UnsupportedOperandTypeError("*", getSVMLType(left), getSVMLType(right));
          }
          break;
        }
        case OpCodes.MULF: {
          const right = this.pop() as number;
          const left = this.pop() as number;
          this.push(left * right);
          break;
        }
        case OpCodes.DIVG: {
          // Python `/` is true division: result is always float.
          const right = this.pop();
          const left = this.pop();
          if (!isNumeric(left) || !isNumeric(right)) {
            throw new UnsupportedOperandTypeError("/", getSVMLType(left), getSVMLType(right));
          }
          const r = toNumber(right);
          if (r === 0) throw new ZeroDivisionError("division by zero");
          this.push(toNumber(left) / r);
          break;
        }
        case OpCodes.DIVF: {
          const right = this.pop() as number;
          const left = this.pop() as number;
          if (right === 0) throw new ZeroDivisionError("division by zero");
          this.push(left / right);
          break;
        }
        case OpCodes.FLOORDIVG: {
          const right = this.pop();
          const left = this.pop();
          if (typeof left === "bigint" && typeof right === "bigint") {
            if (right === 0n) throw new ZeroDivisionError("integer division or modulo by zero");
            // Python floor-div for bigint: truncate then adjust for negative remainder
            const q = left / right;
            const adjusted = left % right !== 0n && ((left < 0n) !== (right < 0n)) ? q - 1n : q;
            this.push(adjusted);
          } else if (isNumeric(left) && isNumeric(right)) {
            const r = toNumber(right);
            if (r === 0) throw new ZeroDivisionError("integer division or modulo by zero");
            this.push(Math.floor(toNumber(left) / r));
          } else {
            throw new UnsupportedOperandTypeError("//", getSVMLType(left), getSVMLType(right));
          }
          break;
        }
        case OpCodes.FLOORDIVF: {
          const right = this.pop() as number;
          const left = this.pop() as number;
          if (right === 0) throw new ZeroDivisionError("division by zero");
          this.push(Math.floor(left / right));
          break;
        }
        case OpCodes.MODG: {
          const right = this.pop();
          const left = this.pop();
          if (typeof left === "bigint" && typeof right === "bigint") {
            if (right === 0n) throw new ZeroDivisionError("integer modulo by zero");
            this.push(pythonMod(left, right) as bigint);
          } else if (isNumeric(left) && isNumeric(right)) {
            const r = toNumber(right);
            if (r === 0) throw new ZeroDivisionError("integer modulo by zero");
            this.push(pythonMod(toNumber(left), r) as number);
          } else {
            throw new UnsupportedOperandTypeError("%", getSVMLType(left), getSVMLType(right));
          }
          break;
        }
        case OpCodes.MODF: {
          const right = this.pop() as number;
          const left = this.pop() as number;
          if (right === 0) throw new ZeroDivisionError("integer modulo by zero");
          this.push(pythonMod(left, right) as number);
          break;
        }
        // Unary operations
        case OpCodes.NEGG: {
          const operand = this.pop();
          if (typeof operand === "bigint") {
            this.push(-operand);
          } else if (typeof operand === "number") {
            this.push(-operand);
          } else {
            throw new UnsupportedOperandTypeError("-", getSVMLType(operand));
          }
          break;
        }
        case OpCodes.NEGF: {
          const operand = this.pop() as number;
          this.push(-operand);
          break;
        }
        case OpCodes.NOTG: {
          const operand = this.pop();
          if (typeof operand !== "boolean") {
            throw new UnsupportedOperandTypeError("not", getSVMLType(operand));
          }
          this.push(!operand);
          break;
        }
        case OpCodes.NOTB:
          this.negateBoolean();
          break;

        // Comparison operations
        case OpCodes.LTG:
          this.genericOrderedComparison("<");
          break;
        case OpCodes.LTF:
          this.lessThanNumbers();
          break;

        case OpCodes.GTG:
          this.genericOrderedComparison(">");
          break;
        case OpCodes.GTF:
          this.greaterThanNumbers();
          break;

        case OpCodes.LEG:
          this.genericOrderedComparison("<=");
          break;
        case OpCodes.LEF:
          this.lessThanOrEqualNumbers();
          break;

        case OpCodes.GEG:
          this.genericOrderedComparison(">=");
          break;
        case OpCodes.GEF:
          this.greaterThanOrEqualNumbers();
          break;

        case OpCodes.EQG:
        case OpCodes.EQF:
        case OpCodes.EQB:
          this.strictEqual();
          break;

        case OpCodes.NEQG:
        case OpCodes.NEQF:
        case OpCodes.NEQB:
          this.strictNotEqual();
          break;

        // Variable operations
        case OpCodes.LDLG:
        case OpCodes.LDLF:
        case OpCodes.LDLB:
          this.loadLocal(a1);
          break;

        case OpCodes.STLG:
        case OpCodes.STLF:
        case OpCodes.STLB:
          this.storeLocal(a1);
          break;

        case OpCodes.LDPG:
        case OpCodes.LDPF:
        case OpCodes.LDPB:
          this.loadParent(a1, a2);
          break;

        case OpCodes.STPG:
        case OpCodes.STPF:
        case OpCodes.STPB:
          this.storeParent(a1, a2);
          break;

        // Control flow
        case OpCodes.BR:
          this.branch(a1);
          break;

        case OpCodes.BRT:
          this.branchIfTrue(a1);
          break;

        case OpCodes.BRF:
          this.branchIfFalse(a1);
          break;

        // Function operations
        case OpCodes.NEWC:
          this.createClosure(a1);
          break;

        case OpCodes.CALL:
          this.call(a1, false, pc);
          break;

        case OpCodes.CALLT:
          this.call(a1, true, pc);
          break;

        case OpCodes.CALLP:
        case OpCodes.CALLTP:
          this.callPrimitive(a1, a2);
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

        // Iterator opcodes
        case OpCodes.NEWITER: {
          const iterable = this.pop();
          if (isSVMLObject(iterable)) {
            if (iterable.type === "array") {
              const iter: SVMLIterator = {
                type: "iterator",
                kind: "list",
                array: iterable,
                index: 0,
              };
              this.push(iter);
            } else if (iterable.type === "iterator") {
              this.push(iterable); // identity
            } else {
              throw new Error("NEWITER: value is not iterable");
            }
          } else {
            throw new Error("NEWITER: value is not iterable");
          }
          break;
        }

        case OpCodes.FOR_ITER: {
          const iter = this.peek() as SVMLIterator;
          let done = false;
          let nextValue: SVMLBoxType = undefined;

          if (iter.kind === "range") {
            const going =
              iter.step! > 0n ? iter.current! < iter.stop! : iter.current! > iter.stop!;
            if (going) {
              nextValue = iter.current!;
              iter.current = iter.current! + iter.step!;
            } else {
              done = true;
            }
          } else {
            // "list"
            if (iter.index! < iter.array!.elements.length) {
              nextValue = iter.array!.elements[iter.index!++];
            } else {
              done = true;
            }
          }

          if (done) {
            this.pop(); // remove iterator from stack
            this.branch(a1);
          } else {
            this.push(nextValue);
          }
          break;
        }

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
          throw new Error(`Unimplemented opcode: ${op} (${OpCodes[op] || "UNKNOWN"})`);
      }
    }

    return this.currentFrame && this.currentFrame.stack.length > 0
      ? this.currentFrame.stack[this.currentFrame.stack.length - 1]
      : undefined;
  }

  // ========================================================================
  // Stack Operations
  // ========================================================================

  private push(value: SVMLBoxType): void {
    if (!this.currentFrame) {
      throw new Error("No current frame for push");
    }
    if (this.currentFrame.stack.length >= this.maxStackSize) {
      throw new Error(`Stack overflow (max: ${this.maxStackSize})`);
    }
    this.currentFrame.stack.push(value);
  }

  private pop(): SVMLBoxType {
    if (!this.currentFrame) {
      throw new Error("No current frame for pop");
    }
    if (this.currentFrame.stack.length === 0) {
      if (__DEBUG__)
        debug(`STACK UNDERFLOW! Current frame: ${this.currentFrame.closure.functionIndex}`);
      throw new Error("Stack underflow");
    }
    const value = this.currentFrame.stack.pop()!;
    if (__DEBUG__) debug(`  Popped: ${JSON.stringify(SVMLInterpreter.toJSValue(value))}`);
    return value;
  }

  private peek(offset: number = 0): SVMLBoxType {
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

  private negateBoolean(): void {
    const operand = this.pop() as boolean;
    this.push(!operand);
  }

  private lessThanNumbers(): void {
    const right = this.pop() as number;
    const left = this.pop() as number;
    this.push(left < right);
  }

  private greaterThanNumbers(): void {
    const right = this.pop() as number;
    const left = this.pop() as number;
    this.push(left > right);
  }

  private lessThanOrEqualNumbers(): void {
    const right = this.pop() as number;
    const left = this.pop() as number;
    this.push(left <= right);
  }

  private greaterThanOrEqualNumbers(): void {
    const right = this.pop() as number;
    const left = this.pop() as number;
    this.push(left >= right);
  }

  private strictEqual(): void {
    const right = this.pop();
    const left = this.pop();
    this.push(pythonEqual(left, right));
  }

  private strictNotEqual(): void {
    const right = this.pop();
    const left = this.pop();
    this.push(!pythonEqual(left, right));
  }

  private genericOrderedComparison(op: "<" | ">" | "<=" | ">="): void {
    const right = this.pop();
    const left = this.pop();
    const leftType = getSVMLType(left);
    const rightType = getSVMLType(right);

    // Numeric compare is cross-type (int/float). JS's <,>,<=,>= natively
    // compare bigint against number by value, so no explicit coercion is
    // needed here — typeof filtering is sufficient.
    const bothNumbers = isNumeric(left) && isNumeric(right);
    const bothStrings = leftType === SVMLType.STRING && rightType === SVMLType.STRING;
    if (!bothNumbers && !bothStrings) {
      throw new UnsupportedOperandTypeError(op, leftType, rightType);
    }

    const l = left as number | bigint | string;
    const r = right as number | bigint | string;
    if (op === "<") this.push(l < r);
    else if (op === ">") this.push(l > r);
    else if (op === "<=") this.push(l <= r);
    else this.push(l >= r);
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
    if (__DEBUG__)
      debug(`[STLG] Storing to slot ${slot}: ${JSON.stringify(SVMLInterpreter.toJSValue(value))}`);
    this.currentFrame.env.set(slot, value);
  }

  private loadParent(slot: number, level: number): void {
    if (!this.currentFrame) {
      throw new Error("No current frame");
    }

    if (__DEBUG__) debug(`[LDPG] Loading from parent env: slot=${slot}, level=${level}`);

    const parentEnv = this.currentFrame.env.getParent(level);
    if (__DEBUG__) debug(`[LDPG] Parent env has ${parentEnv.getSize()} slots`);
    const value = parentEnv.get(slot);
    if (__DEBUG__)
      debug(`[LDPG] Loaded value: ${JSON.stringify(SVMLInterpreter.toJSValue(value))}`);
    this.push(value);
  }

  private storeParent(slot: number, level: number): void {
    if (!this.currentFrame) {
      throw new Error("No current frame");
    }
    const value = this.pop();
    const parentEnv = this.currentFrame.env.getParent(level);
    parentEnv.set(slot, value);
  }

  /** Emit a per-function return observation for user-defined functions only.
   *  FileInput returns are ignored: return-kind speculation is keyed by
   *  FunctionDef.id and only narrows function units. */
  private dispatchReturnSite(value: SVMLBoxType): void {
    if (!this.currentFrame) return;
    const scopeKey = this.currentFrame.ir.scopeKey;
    if (!(scopeKey instanceof StmtNS.FunctionDef)) return;
    this.dispatchReturn(scopeKey.id, value);
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

  /** Python truthiness: mirrors bool(x) semantics. */
  private isTruthy(value: SVMLBoxType): boolean {
    if (value === null || value === undefined || value === false) return false;
    if (typeof value === "number") return value !== 0;
    if (typeof value === "string") return value.length > 0;
    if (typeof value === "boolean") return value; // true
    if (typeof value === "object" && value !== null) {
      if ((value as SVMLArray).type === "array") return (value as SVMLArray).elements.length > 0;
      return true; // closures and iterators are always truthy
    }
    return true;
  }

  private branchIfTrue(offset: number): void {
    const condition = this.pop();
    if (this.isTruthy(condition)) {
      this.branch(offset);
    }
  }

  private branchIfFalse(offset: number): void {
    const condition = this.pop();
    if (!this.isTruthy(condition)) {
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

    const closure: SVMLClosure = {
      type: "closure",
      functionIndex,
      parentEnv: this.currentFrame.env,
    };

    this.push(closure);
  }

  private call(numArgs: number, isTailCall: boolean, pc: number): void {
    if (!this.currentFrame) {
      throw new Error("No current frame");
    }

    // Check call depth
    if (!isTailCall && this.callDepth >= this.maxCallDepth) {
      throw new Error(`Maximum call depth exceeded (${this.maxCallDepth})`);
    }

    if (__DEBUG__)
      debug(
        `[CALL] numArgs=${numArgs}, stackSize=${this.currentFrame.stack}, isTail=${isTailCall}`,
      );

    // Stack layout: [... func arg1 arg2 ... argN] with argN on top
    const args = new Array<SVMLBoxType>(numArgs);
    for (let i = numArgs - 1; i >= 0; i--) {
      if (this.currentFrame?.stack.length === 0) {
        throw new Error(`Stack underflow while popping argument ${i}/${numArgs}. Stack was empty.`);
      }
      args[i] = this.pop();
    }

    if (__DEBUG__)
      debug(`[CALL] Popped ${numArgs} args, stack now has ${this.currentFrame.stack.length} items`);

    if (this.currentFrame?.stack.length === 0) {
      throw new Error(
        `Stack underflow while popping function. ` +
          `After popping ${numArgs} arguments, stack is empty. ` +
          `This means the function was never pushed onto the stack. ` +
          `Check that LDLG/LDPG is being emitted before arguments.`,
      );
    }

    const func = this.pop();
    if (__DEBUG__)
      debug(`[CALL] Popped function: ${JSON.stringify(SVMLInterpreter.toJSValue(func))}`);

    if (!isSVMLObject(func) || func.type !== "closure") {
      throw new Error(
        `Cannot call non-closure value: ${JSON.stringify(SVMLInterpreter.toJSValue(func))}`,
      );
    }

    const closure = func;

    const canonical = this.program.functions[closure.functionIndex];

    if (numArgs !== canonical.numArgs) {
      throw new Error(`Function expects ${canonical.numArgs} arguments but got ${numArgs}`);
    }

    // JIT dispatch: give the hook the chance to observe the call, publish
    // param observations, and return a specialized IR compiled under the
    // post-observation chain. `undefined` means "use canonical."
    let funcDef = canonical;
    if (
      this.dispatchCall !== undefined &&
      canonical.scopeKey instanceof StmtNS.FunctionDef
    ) {
      const specialized = this.dispatchCall(canonical.scopeKey.id, args);
      if (specialized !== undefined) funcDef = specialized;
    }

    const newEnv = new SVMLEnvironment(funcDef.envSize, closure.parentEnv);
    for (let i = 0; i < numArgs; i++) {
      newEnv.set(i, args[i]);
      if (__DEBUG__)
        debug(`[CALL] Set env slot ${i} = ${JSON.stringify(SVMLInterpreter.toJSValue(args[i]))}`);
    }

    if (__DEBUG__)
      debug(
        `[CALL] Created new env with ${funcDef.envSize} slots, parent exists: ${closure.parentEnv !== null}`,
      );

    if (isTailCall) {
      this.currentFrame.closure = closure;
      this.currentFrame.ir = funcDef;
      this.currentFrame.pc = 0;
      this.currentFrame.env = newEnv;
      this.currentFrame.stack = [];
    } else {
      const newFrame: CallFrame = {
        closure,
        ir: funcDef,
        pc: 0,
        env: newEnv,
        stack: [],
        callerFrame: this.currentFrame,
      };
      this.currentFrame = newFrame;
      this.callDepth++;
    }
  }

  private callPrimitive(primitiveIndex: number, numArgs: number): void {
    if (__DEBUG__) debug(`[CALLP] primitiveIndex=${primitiveIndex}, numArgs=${numArgs}`);

    // Primitives pop N arguments only — no function object on the stack
    const args = new Array<SVMLBoxType>(numArgs);
    for (let i = numArgs - 1; i >= 0; i--) {
      if (this.currentFrame?.stack.length === 0) {
        throw new Error(`Stack underflow in primitive call while popping argument ${i}/${numArgs}`);
      }
      args[i] = this.pop();
    }

    if (__DEBUG__)
      debug(
        `[CALLP] Calling primitive ${primitiveIndex} with args: ${JSON.stringify(args.map(a => SVMLInterpreter.toJSValue(a)))}`,
      );

    const result = executePrimitive(primitiveIndex, args, this.onOutput);
    this.push(result);

    if (__DEBUG__)
      debug(`[CALLP] Primitive returned: ${JSON.stringify(SVMLInterpreter.toJSValue(result))}`);
  }

  private return(): void {
    if (!this.currentFrame) {
      throw new Error("No current frame");
    }

    // Pop return value from CURRENT (callee's) stack
    const returnValue = this.pop();
    this.dispatchReturnSite(returnValue);

    if (__DEBUG__)
      debug(`[RETG] Returning value: ${JSON.stringify(SVMLInterpreter.toJSValue(returnValue))}`);

    const callerFrame = this.currentFrame.callerFrame;

    if (!callerFrame) {
      this.halted = true;
      this.push(returnValue);
      return;
    }

    this.currentFrame = callerFrame;
    this.callDepth--;
    this.push(returnValue);

    if (__DEBUG__)
      debug(
        `[RETG] Pushed return value to caller's stack, size now: ${this.currentFrame.stack.length}`,
      );
  }

  // ========================================================================
  // Array Operations
  // ========================================================================

  private createArray(): void {
    // Python list sizes are int (bigint at runtime); coerce for JS Array ctor.
    const size = Number(this.pop() as number | bigint);
    const arr: SVMLArray = {
      type: "array",
      elements: new Array(size).fill(undefined),
    };
    this.push(arr);
  }

  private loadArrayElement(): void {
    const index = Number(this.pop() as number | bigint);
    const arr = this.pop();

    if (!isSVMLObject(arr) || arr.type !== "array") {
      throw new Error("Cannot index non-array value");
    }

    if (index < 0 || index >= arr.elements.length) {
      throw new Error(`Array index ${index} out of bounds (length: ${arr.elements.length})`);
    }

    this.push(arr.elements[index]);
  }

  private storeArrayElement(): void {
    const value = this.pop();
    const index = Number(this.pop() as number | bigint);
    const arr = this.pop();

    if (!isSVMLObject(arr) || arr.type !== "array") {
      throw new Error("Cannot index non-array value");
    }

    if (index < 0 || index >= arr.elements.length) {
      throw new Error(`Array index ${index} out of bounds (length: ${arr.elements.length})`);
    }

    arr.elements[index] = value;
  }

  // ========================================================================
  // Utility Methods
  // ========================================================================

  /**
   * Convert runtime value to JavaScript value for display
   */
  static toJSValue(value: SVMLBoxType): unknown {
    if (value === null || value === undefined) return value;
    if (typeof value === "number" || typeof value === "boolean" || typeof value === "string")
      return value;
    // Display-friendly: flatten Python int → JS number for callers that
    // don't care about int/float distinction (debug logs, tests that
    // predate the int/float split). Python semantics still live on the
    // stack as bigint — this conversion is one-way at the display edge.
    if (typeof value === "bigint") {
      return Number(value);
    }
    if (isSVMLObject(value)) {
      if (value.type === "closure") return `<closure:${value.functionIndex}>`;
      if (value.type === "array") return value.elements.map(e => SVMLInterpreter.toJSValue(e));
      if (value.type === "iterator") return `<iterator>`;
    }
    return String(value);
  }
}
