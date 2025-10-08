/**
 * VM Module Exports
 * 
 * This module provides:
 * - SVML Compiler: Compiles Python AST to SVML bytecode
 * - SVML Interpreter: Executes SVML bytecode directly (TypeScript implementation)
 * - Instrumentation: Tracks recursion and applies memoization
 */

// Core compiler
export { SVMLCompiler } from "./svml-compiler";

// TypeScript interpreter (no WASM needed!)
export { SVMLInterpreter, runSVMLProgram } from "./svml-interpreter";

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

/**
 * Quick start example:
 * 
 * ```typescript
 * import { parse } from "../parser";
 * import { SVMLCompiler, runSVMLProgram } from "./vm";
 * 
 * const code = `
 * def fibonacci(n):
 *     if n <= 1:
 *         return n
 *     return fibonacci(n - 1) + fibonacci(n - 2)
 * 
 * result = fibonacci(10)
 * `;
 * 
 * // Parse Python code
 * const ast = parse(code);
 * 
 * // Compile to SVML
 * const compiler = SVMLCompiler.fromProgram(ast);
 * const program = compiler.compileProgram(ast);
 * 
 * // Run with TypeScript interpreter
 * // Instrumentation automatically detects recursion and applies memoization!
 * const result = runSVMLProgram(program, compiler.getInstrumentation());
 * 
 * console.log(result); // 55
 * ```
 */

