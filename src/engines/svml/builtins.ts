import type { SVMLBoxType } from "./types";
import { isSVMLObject } from "./types";
import { MissingRequiredPositionalError, SVMLInterpreterError } from "./errors";
import {
  memoLookup as _memoLookup,
  memoPut as _memoPut,
  MEMO_MISS,
  MEMO_INTRINSIC_NAMES,
} from "../../runtime/memo";

const [MEMO_HAS_NAME, MEMO_GET_NAME, MEMO_PUT_NAME] = MEMO_INTRINSIC_NAMES;

// Map Python builtin names to SVML primitive opcode indices
export const PRIMITIVE_FUNCTIONS: Map<string, number> = new Map([
  ["print", 5],
  ["display", 5], // Alias for print
  ["abs", 10],
  ["min", 20],
  ["max", 21],
  ["pow", 22],
  ["sqrt", 23],
  ["floor", 24],
  ["ceil", 25],
  ["round", 26],
  ["range", 30],
  ["len", 31],
  [MEMO_HAS_NAME, 40],
  [MEMO_GET_NAME, 41],
  [MEMO_PUT_NAME, 42],
]);

/** Accept Python int (bigint) or float (number); coerce bigint → number.
 *  Caller gets plain JS numbers — use for helpers (Math.*) that don't care
 *  about Python int-ness of the result. For type-preserving ops, inspect
 *  the raw args before calling this. */
function assertNumericArgs(args: SVMLBoxType[], fn: string): number[] {
  if (!args.every(a => typeof a === "number" || typeof a === "bigint"))
    throw new SVMLInterpreterError(`TypeError: ${fn}() requires numeric arguments`);
  return args.map(a => (typeof a === "bigint" ? Number(a) : (a as number)));
}

/** Python's str(x) for int/float, matching CSE's toPythonFloat formatting:
 *  bigint → decimal string with no trailing `.0`; number → Python float
 *  format where integer-valued floats render as "1.0", not "1". */
function toPythonDisplay(v: SVMLBoxType): string {
  if (typeof v === "bigint") return v.toString();
  if (typeof v === "number") {
    if (Number.isNaN(v)) return "nan";
    if (!Number.isFinite(v)) return v > 0 ? "inf" : "-inf";
    if (Number.isInteger(v)) return v.toFixed(1);
    return v.toString();
  }
  if (typeof v === "boolean") return v ? "True" : "False";
  if (v === null) return "None";
  if (v === undefined) return "None";
  if (typeof v === "string") return v;
  // SVMLObject
  if (isSVMLObject(v)) {
    if (v.type === "array") return `[${v.elements.map(toPythonDisplay).join(", ")}]`;
    if (v.type === "closure") return `<function at ${v.functionIndex}>`;
    if (v.type === "iterator") return `<iterator>`;
  }
  return String(v);
}

/**
 * Execute a primitive function.
 * Called by the TypeScript interpreter for primitive operations.
 */
export function executePrimitive(
  primitiveIndex: number,
  args: SVMLBoxType[],
  sendOutput: (message: string) => void,
): SVMLBoxType {
  switch (primitiveIndex) {
    case 5: // print/display
      sendOutput(args.map(toPythonDisplay).join(" "));
      return undefined;

    case 10: {
      // abs — type-preserving: int stays int, float stays float.
      if (args.length !== 1)
        throw new MissingRequiredPositionalError("abs() takes exactly 1 argument");
      const x = args[0];
      if (typeof x === "bigint") return x < 0n ? -x : x;
      if (typeof x === "number") return Math.abs(x);
      throw new SVMLInterpreterError(`TypeError: abs() requires a numeric argument`);
    }

    case 20: {
      // min
      if (args.length < 2)
        throw new MissingRequiredPositionalError(
          `min() takes at least 2 arguments (${args.length} given)`,
        );
      return Math.min(...assertNumericArgs(args, "min"));
    }

    case 21: {
      // max
      if (args.length < 2)
        throw new MissingRequiredPositionalError(
          `max() takes at least 2 arguments (${args.length} given)`,
        );
      return Math.max(...assertNumericArgs(args, "max"));
    }

    case 22: {
      // pow
      if (args.length !== 2)
        throw new MissingRequiredPositionalError("pow() takes exactly 2 arguments");
      const [base, exp] = assertNumericArgs(args, "pow");
      return Math.pow(base, exp);
    }

    case 23: {
      // sqrt
      if (args.length !== 1)
        throw new MissingRequiredPositionalError("sqrt() takes exactly 1 argument");
      const [n] = assertNumericArgs(args, "sqrt");
      return Math.sqrt(n);
    }

    case 24: {
      // floor — returns Python int (bigint).
      if (args.length !== 1)
        throw new MissingRequiredPositionalError("floor() takes exactly 1 argument");
      const raw = args[0];
      if (typeof raw === "bigint") return raw;
      const [n] = assertNumericArgs(args, "floor");
      return BigInt(Math.floor(n));
    }

    case 25: {
      // ceil — returns Python int.
      if (args.length !== 1)
        throw new MissingRequiredPositionalError("ceil() takes exactly 1 argument");
      const raw = args[0];
      if (typeof raw === "bigint") return raw;
      const [n] = assertNumericArgs(args, "ceil");
      return BigInt(Math.ceil(n));
    }

    case 26: {
      // round — returns Python int.
      if (args.length !== 1)
        throw new MissingRequiredPositionalError("round() takes exactly 1 argument");
      const raw = args[0];
      if (typeof raw === "bigint") return raw;
      const [n] = assertNumericArgs(args, "round");
      return BigInt(Math.round(n));
    }

    case 30: {
      // range — args are Python ints; iterator yields Python ints (bigint).
      if (args.length < 1 || args.length > 3)
        throw new MissingRequiredPositionalError(
          `range() takes 1 to 3 arguments (${args.length} given)`,
        );
      if (!args.every(a => typeof a === "bigint"))
        throw new SVMLInterpreterError("TypeError: range() integer arguments expected");
      const bigs = args as bigint[];
      const [a, b, c] = bigs;
      const [start, stop, step] =
        args.length === 1 ? [0n, a, 1n] : args.length === 2 ? [a, b, 1n] : [a, b, c];
      if (step === 0n)
        throw new SVMLInterpreterError("ValueError: range() arg 3 must not be zero");
      return { type: "iterator", kind: "range", current: start, stop, step };
    }

    case 31: {
      // len — Python int result.
      if (args.length !== 1)
        throw new MissingRequiredPositionalError("len() takes exactly 1 argument");
      const v = args[0];
      if (isSVMLObject(v) && v.type === "array") return BigInt(v.elements.length);
      if (typeof v === "string") return BigInt(v.length);
      throw new SVMLInterpreterError(`TypeError: object of type '${typeof v}' has no len()`);
    }

    case 40: {
      // __memo_has(id, *keyArgs)
      const [id, ...keyArgs] = memoArgs(args, "__memo_has");
      return _memoLookup(id, keyArgs) !== MEMO_MISS;
    }

    case 41: {
      // __memo_get(id, *keyArgs) — transform always gates on __memo_has first,
      // so a miss here returns undefined rather than a sentinel the VM cannot
      // represent.
      const [id, ...keyArgs] = memoArgs(args, "__memo_get");
      const v = _memoLookup(id, keyArgs);
      return v === MEMO_MISS ? undefined : (v as SVMLBoxType);
    }

    case 42: {
      // __memo_put(id, *keyArgs, value) — last positional is the value;
      // returns the value so the caller can `return __memo_put(...)` inline.
      if (args.length < 2)
        throw new MissingRequiredPositionalError("__memo_put() requires id and value");
      const [id, ...rest] = memoArgs(args, "__memo_put");
      const value = rest[rest.length - 1];
      _memoPut(id, rest.slice(0, -1), value);
      return value;
    }

    default:
      throw new SVMLInterpreterError(`Unknown primitive function index: ${primitiveIndex}`);
  }
}

function memoArgs(args: SVMLBoxType[], fn: string): [string, ...SVMLBoxType[]] {
  if (args.length < 1) throw new MissingRequiredPositionalError(`${fn}() requires id`);
  const id = args[0];
  if (typeof id !== "string") throw new SVMLInterpreterError(`${fn}() id must be a string`);
  return [id, ...args.slice(1)];
}
