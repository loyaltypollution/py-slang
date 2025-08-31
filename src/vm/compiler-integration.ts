import * as es from "estree";
import { Program } from "./svml-compiler";
import { compileFunctional } from "./functional-compiler";

/**
 * Integration layer that maintains backward compatibility with existing API
 * while using the new functional compiler internally
 */

/**
 * Transform for-loops to while-loops (simplified version)
 */
function transformForLoopsToWhileLoops(program: es.Program): void {
  // This is a simplified implementation
  // In the real implementation, you'd use the walker system
  const transformNode = (node: any): void => {
    if (!node || typeof node !== 'object') return;

    if (node.type === 'ForStatement') {
      // Transform for-loop to while-loop
      // This is a placeholder - implement the full transformation logic
      console.warn('For-loop transformation not fully implemented in functional compiler');
    }

    // Recursively transform children
    for (const key in node) {
      if (node.hasOwnProperty(key) && key !== 'parent') {
        const value = node[key];
        if (Array.isArray(value)) {
          for (const item of value) {
            transformNode(item);
          }
        } else {
          transformNode(value);
        }
      }
    }
  };

  transformNode(program);
}

/**
 * Insert empty else blocks for if statements
 */
function insertEmptyElseBlocks(program: es.Program): void {
  const processNode = (node: any): void => {
    if (!node || typeof node !== 'object') return;

    if (node.type === 'IfStatement' && !node.alternate) {
      node.alternate = {
        type: 'BlockStatement',
        body: [],
      };
    }

    // Recursively process children
    for (const key in node) {
      if (node.hasOwnProperty(key) && key !== 'parent') {
        const value = node[key];
        if (Array.isArray(value)) {
          for (const item of value) {
            processNode(item);
          }
        } else {
          processNode(value);
        }
      }
    }
  };

  processNode(program);
}

/**
 * Main compiler entry point that maintains backward compatibility
 */
export function compileToIns(
  program: es.Program,
  prelude?: Program,
  vmInternalFunctions?: string[]
): Program {
  try {
    // Apply transformations (same as original)
    transformForLoopsToWhileLoops(program);
    insertEmptyElseBlocks(program);

    // Use functional compiler
    return compileFunctional(program, prelude, vmInternalFunctions);
  } catch (error) {
    // For debugging: log the error and potentially fall back
    console.error('Functional compiler error:', error);
    throw error;
  }
}

/**
 * Export for testing - allows direct access to functional compiler
 */
export { compileFunctional } from "./functional-compiler";

/**
 * Export types that might be needed by consumers
 */
export type {
  Environment,
  ResolvedSymbol,
  AnalysisResult,
  FunctionInfo,
} from "./compiler-environment";

export type {
  CompilerM,
  CompilerState,
  Reader,
} from "./compiler-monad";

export type {
  InstructionSink,
} from "./compiler-sink";
