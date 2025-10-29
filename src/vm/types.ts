export type SVMLBoxType =
  | number
  | boolean
  | string
  | null
  | undefined
  | SVMLClosure
  | SVMLArray;

export enum SVMLType {
  UNDEFINED = "undefined",
  NULL = "null",
  BOOLEAN = "boolean",
  NUMBER = "number",
  STRING = "string",
  ARRAY = "array",
  CLOSURE = "closure",
}

export interface SVMLArray {
  type: "array";
  elements: SVMLBoxType[];
}

export interface SVMLClosure {
  type: "closure";
  functionIndex: number;
  parentEnv: SVMLEnvironment | null;
  isMemoized?: boolean;
  memoCache?: Map<string, SVMLBoxType>;
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
      throw new Error(
        `Environment slot ${slot} out of bounds (size: ${this.locals.length})`
      );
    }
    return this.locals[slot];
  }

  set(slot: number, value: SVMLBoxType): void {
    if (slot < 0 || slot >= this.locals.length) {
      throw new Error(
        `Environment slot ${slot} out of bounds (size: ${this.locals.length})`
      );
    }
    this.locals[slot] = value;
  }

  getParent(level: number): SVMLEnvironment {
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

export interface Instruction {
  opcode: number;
  arg1?: SVMLBoxType;
  arg2?: SVMLBoxType;
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

export function getSVMLType(value: SVMLBoxType): SVMLType {
  if (typeof value === "number") {
    return SVMLType.NUMBER;
  } else if (typeof value === "string") {
    return SVMLType.STRING;
  } else if (typeof value === "boolean") {
    return SVMLType.BOOLEAN;
  } else if (value === null) {
    return SVMLType.NULL;
  } else if (typeof value === "undefined") {
    return SVMLType.UNDEFINED;
  } else if (
    typeof value === "object" &&
    value !== null &&
    (value as any).type === "closure"
  ) {
    return SVMLType.CLOSURE;
  } else if (
    typeof value === "object" &&
    value !== null &&
    (value as any).type === "array"
  ) {
    return SVMLType.ARRAY;
  } else {
    throw new Error(`Unknown runtime type: ${typeof value}`);
  }
}
