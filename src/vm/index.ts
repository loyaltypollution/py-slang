// Core compiler
export { SVMLCompiler } from "./svml-compiler";

// TypeScript interpreter
export { SVMLInterpreter } from "./svml-interpreter";

// Instrumentation and optimization
export {
  InstrumentationTracker,
  InstrumentationConfig,
  DEFAULT_INSTRUMENTATION_CONFIG,
  FunctionInfo,
  createMemoizedWrapper,
  getMemoizationStats,
  clearMemoizationCache,
} from "./instrumentation";

// Types
export { SVMProgram, SVMFunction, Instruction, FunctionBuilder } from "./types";

// Opcodes
export { default as OpCodes } from "./opcodes";

// Primitives
export { PRIMITIVE_FUNCTIONS, executePrimitive } from "./sinter-primitives";
