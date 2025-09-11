// Minimal vm prelude for py-slang SVML compiler
export const vmPrelude = ''

// Direct mapping of primitive functions to their runtime opcodes and arity
// Format: [functionName, stackSize, envSize, numArgs, isVarArgs]
export const PRIMITIVE_FUNCTIONS: Map<number, [string, number, number, number, boolean]> = new Map([
  [5, ['print', 1, 0, -1, true]],  // CALLP 0 -> executes DISPLAY opcode
])

// Internal VM functions
export const INTERNAL_FUNCTIONS: [string, number, boolean][] = []

// Constant primitives
export const CONSTANT_PRIMITIVES: [string, any][] = []
