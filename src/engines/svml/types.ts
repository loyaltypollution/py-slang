import type { StmtNS } from "../../ast-types";

export type SVMLBoxType =
  | number
  | bigint
  | boolean
  | string
  | null
  | undefined
  | SVMLClosure
  | SVMLArray
  | SVMLIterator;

export enum SVMLType {
  UNDEFINED = "undefined",
  NULL = "null",
  BOOLEAN = "boolean",
  INT = "int",
  FLOAT = "float",
  STRING = "string",
  ARRAY = "array",
  CLOSURE = "closure",
  ITERATOR = "iterator",
}

export interface SVMLArray {
  type: "array";
  elements: SVMLBoxType[];
}

export interface SVMLIterator {
  type: "iterator";
  kind: "range" | "list";
  // range fields — bigint because Python range yields ints.
  current?: bigint;
  stop?: bigint;
  step?: bigint;
  // list fields
  array?: SVMLArray;
  index?: number;
}

export interface SVMLClosure {
  type: "closure";
  functionIndex: number;
  parentEnv: SVMLEnvironment | null;
}

/** Type guard: narrows SVMLBoxType to the three object variants. */
export function isSVMLObject(value: SVMLBoxType): value is SVMLClosure | SVMLArray | SVMLIterator {
  return typeof value === "object" && value !== null && "type" in value;
}

export class SVMLEnvironment {
  private locals: SVMLBoxType[];
  private parent: SVMLEnvironment | null;

  constructor(size: number, parent: SVMLEnvironment | null = null) {
    this.locals = new Array(size).fill(undefined);
    this.parent = parent;
  }

  get(slot: number): SVMLBoxType {
    if (slot < 0 || slot >= this.locals.length) {
      throw new Error(`Environment slot ${slot} out of bounds (size: ${this.locals.length})`);
    }
    return this.locals[slot];
  }

  set(slot: number, value: SVMLBoxType): void {
    if (slot < 0 || slot >= this.locals.length) {
      throw new Error(`Environment slot ${slot} out of bounds (size: ${this.locals.length})`);
    }
    this.locals[slot] = value;
  }

  getParent(level: number): SVMLEnvironment {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    let env: SVMLEnvironment | null = this;
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
 * Record-shaped instruction used by the sinter binary assembler and its
 * text-parse path (see svml-assembler.ts). Hot paths — the interpreter
 * dispatch loop and any spec/codegen that walks bytecode — read SVMLIR's
 * typed arrays directly; this shape exists only where a mutable
 * per-instruction record is genuinely more ergonomic than struct-of-arrays.
 */
export interface Instruction {
  opcode: number;
  arg1?: SVMLBoxType;
  arg2?: SVMLBoxType;
}

// ========================================================================
// SVMLIR: immutable IR for a single function
// ========================================================================

import OpCodes from "./opcodes";

/**
 * Runtime observation site attached to a specific pc in an SVMLIR.
 *
 * - `kind: "call"` — CALL/CALLT of a user function. The callee's scopeKey is
 *   derived at runtime from the closure's functionIndex.
 */
export type ObservationSite = { kind: "call" };

/**
 * IR representation of a single compiled function.
 *
 * Produced by SVMLIRBuilder.build() and consumed by SVMLInterpreter.
 * Uses struct-of-arrays typed arrays for cache-friendly dispatch.
 */
const EMPTY_SITES: ReadonlyMap<number, ObservationSite> = new Map();

export class SVMLIR {
  readonly opcodes: Int32Array;
  readonly arg1s: Float64Array;
  readonly arg2s: Int32Array;
  readonly strings: readonly string[];
  readonly count: number;
  readonly stackSize: number;
  readonly envSize: number;
  readonly numArgs: number;
  /** Scope this IR was compiled for (if known — FileInput or FunctionDef). */
  readonly scopeKey: StmtNS.FileInput | StmtNS.FunctionDef | undefined;
  /** pc → observation site metadata. Empty when no sink is attached. */
  readonly observationSites: ReadonlyMap<number, ObservationSite>;

  constructor(
    opcodes: Int32Array,
    arg1s: Float64Array,
    arg2s: Int32Array,
    strings: string[],
    stackSize: number,
    symbolCount: number,
    numArgs: number,
    scopeKey?: StmtNS.FileInput | StmtNS.FunctionDef,
    observationSites?: ReadonlyMap<number, ObservationSite>,
  ) {
    this.opcodes = opcodes;
    this.arg1s = arg1s;
    this.arg2s = arg2s;
    this.strings = strings;
    this.count = opcodes.length;
    this.stackSize = stackSize;
    this.envSize = symbolCount + numArgs;
    this.numArgs = numArgs;
    this.scopeKey = scopeKey;
    this.observationSites = observationSites ?? EMPTY_SITES;
  }

  /** Compatibility: reconstruct Instruction[] for assembler/debug (not hot path). */
  toInstructions(): Instruction[] {
    const result: Instruction[] = [];
    for (let i = 0; i < this.count; i++) {
      const opcode = this.opcodes[i];
      if (opcode === OpCodes.LGCS) {
        result.push({ opcode, arg1: this.strings[this.arg1s[i]] });
      } else {
        result.push({ opcode, arg1: this.arg1s[i], arg2: this.arg2s[i] });
      }
    }
    return result;
  }
}

// ========================================================================
// SVMLProgram: immutable collection of SVMLIR functions
// ========================================================================

/**
 * Immutable program representation: an entry point index and a list of SVMLIR functions.
 * Frozen after construction.
 */
export class SVMLProgram {
  readonly entryPoint: number;
  readonly functions: readonly SVMLIR[];
  constructor(entryPoint: number, functions: SVMLIR[]) {
    this.entryPoint = entryPoint;
    this.functions = Object.freeze([...functions]);
    Object.freeze(this);
  }

  /** Return a new program with one function replaced by a specialized variant. */
  withSpecializedFunction(index: number, newIR: SVMLIR): SVMLProgram {
    const fns = [...this.functions];
    fns[index] = newIR;
    return new SVMLProgram(this.entryPoint, fns);
  }
}

export function getSVMLType(value: SVMLBoxType): SVMLType {
  if (typeof value === "bigint") {
    return SVMLType.INT;
  } else if (typeof value === "number") {
    return SVMLType.FLOAT;
  } else if (typeof value === "string") {
    return SVMLType.STRING;
  } else if (typeof value === "boolean") {
    return SVMLType.BOOLEAN;
  } else if (value === null) {
    return SVMLType.NULL;
  } else if (value === undefined) {
    return SVMLType.UNDEFINED;
  } else if (isSVMLObject(value)) {
    switch (value.type) {
      case "closure":
        return SVMLType.CLOSURE;
      case "array":
        return SVMLType.ARRAY;
      case "iterator":
        return SVMLType.ITERATOR;
    }
  }
  throw new Error(`Unknown runtime type: ${typeof value}`);
}
