import * as es from "estree";
import { UNKNOWN_LOCATION } from "../errors/runtimeSourceError";
import { ConstAssignment, UndefinedVariable } from "../errors/errors";
import { CONSTANT_PRIMITIVES, PRIMITIVE_FUNCTIONS } from "../stdlib/vm-prelude";
import { InstructionBuilder, SVMProgram, Instruction, Argument, SVMFunction } from "./types";
import OpCodes from "./opcodes";
import { arrowFunctionExpression, constantDeclaration } from "../utils/ast/astCreator";

// Import environment analysis
import {
  Environment,
  ResolvedSymbol,
  AnalysisResult,
  FunctionInfo,
  analyzeProgram,
} from "./compiler-environment";

// ============================================================================
// Types and Context
// ============================================================================

/**
 * Compilation context - simple and direct
 */
export type CompilationContext = {
  analysis: AnalysisResult;
  isTopLevel: boolean;
  labelCounter: number;
};

/**
 * Result of compiling an expression - just the stack effect needed
 */
export type ExpressionResult = {
  maxStackSize: number;
};

/**
 * Generate a unique label
 */
function genLabel(context: CompilationContext, prefix: string = "L"): string {
  return `${prefix}${context.labelCounter++}`;
}

// ============================================================================
// Core Expression Compilers - Direct Style
// ============================================================================

/**
 * Compile a literal value - direct, no monads
 */
function compileLiteral(
  node: es.Literal,
  builder: InstructionBuilder
): ExpressionResult {
  const value = node.value;

  if (value === null) {
    builder.emitNullary(OpCodes.LGCN);
  } else if ('bigint' in node) {
    // Handle BigIntLiteral
    const numValue = Number(node.bigint);
    if (Number.isInteger(numValue) && -2_147_483_648 <= numValue && numValue <= 2_147_483_647) {
      builder.emitUnary(OpCodes.LGCI, numValue);
    } else {
      builder.emitUnary(OpCodes.LGCF64, numValue);
    }
  } else {
    // Handle SimpleLiteral
    switch (typeof value) {
      case "boolean":
        builder.emitNullary(value ? OpCodes.LGCB1 : OpCodes.LGCB0);
        break;
      case "number":
        builder.emitUnary(OpCodes.LGCF64, value);
        break;
      case "string":
        builder.emitUnary(OpCodes.LGCS, value);
        break;
      default:
        throw new Error("Unsupported literal type");
    }
  }

  return { maxStackSize: 1 };
}

/**
 * Compile an identifier reference - direct, no monads
 */
function compileIdentifier(
  node: es.Identifier,
  builder: InstructionBuilder,
  context: CompilationContext
): ExpressionResult {
  // Try to get pre-resolved symbol
  const resolved = context.analysis.resolvedIdentifiers.get(node);
  
  if (resolved) {
    // Use pre-resolved information
    if (resolved.type === "primitive") {
      builder.emitUnary(OpCodes.NEWCP, resolved.index);
    } else if (resolved.type === "internal") {
      builder.emitUnary(OpCodes.NEWCV, resolved.index);
    } else if (resolved.envLevel === 0) {
      builder.emitUnary(OpCodes.LDLG, resolved.index);
    } else {
      builder.emitBinary(OpCodes.LDPG, resolved.index, resolved.envLevel);
    }
  } else {
    // Fallback: check constant primitives
    const matches = CONSTANT_PRIMITIVES.filter(
      (f: [string, any]) => f[0] === node.name
    );
    
    if (matches.length === 0) {
      throw new UndefinedVariable(node.name, node);
    }
    
    const [, value] = matches[0];
    if (typeof value === "number") {
      builder.emitUnary(OpCodes.LGCF32, value);
    } else if (value === undefined) {
      builder.emitNullary(OpCodes.LGCU);
    } else {
      throw new Error("Unknown primitive constant");
    }
  }

  return { maxStackSize: 1 };
}

/**
 * Compile a binary expression - direct, no monads
 */
function compileBinaryExpression(
  node: es.BinaryExpression,
  builder: InstructionBuilder,
  context: CompilationContext
): ExpressionResult {
  const VALID_BINARY_OPERATORS = new Map([
    ["+", OpCodes.ADDG],
    ["-", OpCodes.SUBG],
    ["*", OpCodes.MULG],
    ["/", OpCodes.DIVG],
    ["%", OpCodes.MODG],
    ["<", OpCodes.LTG],
    [">", OpCodes.GTG],
    ["<=", OpCodes.LEG],
    [">=", OpCodes.GEG],
    ["===", OpCodes.EQG],
    ["!==", OpCodes.NEQG],
  ]);

  const opcode = VALID_BINARY_OPERATORS.get(node.operator);
  if (!opcode) {
    throw new Error(`Unsupported binary operator: ${node.operator}`);
  }

  // Compile left operand
  const leftResult = compileExpression(node.left as es.Expression, builder, context);
  
  // Compile right operand
  const rightResult = compileExpression(node.right, builder, context);
  
  // Emit the operation
  builder.emitNullary(opcode);

  return {
    maxStackSize: Math.max(leftResult.maxStackSize, 1 + rightResult.maxStackSize)
  };
}

/**
 * Compile a unary expression - direct, no monads
 */
function compileUnaryExpression(
  node: es.UnaryExpression,
  builder: InstructionBuilder,
  context: CompilationContext
): ExpressionResult {
  const VALID_UNARY_OPERATORS = new Map([
    ["!", OpCodes.NOTG],
    ["-", OpCodes.NEGG],
  ]);

  const opcode = VALID_UNARY_OPERATORS.get(node.operator);
  if (!opcode) {
    throw new Error(`Unsupported unary operator: ${node.operator}`);
  }

  // Compile the operand
  const operandResult = compileExpression(node.argument, builder, context);
  
  // Emit the operation
  builder.emitNullary(opcode);

  return { maxStackSize: operandResult.maxStackSize };
}

/**
 * Compile a call expression - direct, no monads
 */
function compileCallExpression(
  node: es.CallExpression,
  builder: InstructionBuilder,
  context: CompilationContext,
  isTailCall: boolean = false
): ExpressionResult {
  if (node.callee.type !== "Identifier") {
    throw new Error("Unsupported call expression");
  }

  const callee = node.callee as es.Identifier;

  // Special case for __py_adder
  if (callee.name === "__py_adder") {
    const arg1Result = compileExpression(node.arguments[0] as es.Expression, builder, context);
    const arg2Result = compileExpression(node.arguments[1] as es.Expression, builder, context);
    builder.emitNullary(OpCodes.ADDG);
    return { maxStackSize: Math.max(arg1Result.maxStackSize, arg2Result.maxStackSize + 1) };
  }

  const resolved = context.analysis.resolvedIdentifiers.get(callee);
  if (!resolved) {
    throw new UndefinedVariable(callee.name, callee);
  }
  
  // Load function if needed
  let functionStackEffect = 0;
  if (resolved.type === "primitive" || resolved.type === "internal") {
    // No function loading needed
  } else if (resolved.envLevel === 0) {
    builder.emitUnary(OpCodes.LDLG, resolved.index);
    functionStackEffect = 1;
  } else {
    builder.emitBinary(OpCodes.LDPG, resolved.index, resolved.envLevel);
    functionStackEffect = 1;
  }
  
  // Compile arguments last, in reverse order
  let maxArgStackSize = 0;
  for (let i = node.arguments.length - 1; i >= 0; i--) {
    const argResult = compileExpression(node.arguments[i] as es.Expression, builder, context);
    maxArgStackSize = Math.max(maxArgStackSize, i + argResult.maxStackSize);
  }

  // Emit call instruction
  const numArgs = node.arguments.length;
  if (resolved.type === "primitive") {
    const opcode = isTailCall ? OpCodes.CALLTP : OpCodes.CALLP;
    builder.emitBinary(opcode, resolved.index, numArgs);
  } else if (resolved.type === "internal") {
    const opcode = isTailCall ? OpCodes.CALLTV : OpCodes.CALLV;
    builder.emitBinary(opcode, resolved.index, numArgs);
  } else {
    const opcode = isTailCall ? OpCodes.CALLT : OpCodes.CALL;
    builder.emitUnary(opcode, numArgs);
  }

  return {
    maxStackSize: functionStackEffect + maxArgStackSize
  };
}

/**
 * Compile a conditional expression - direct, no monads
 */
function compileConditionalExpression(
  node: es.ConditionalExpression,
  builder: InstructionBuilder,
  context: CompilationContext,
  isTailCall: boolean = false
): ExpressionResult {
  const elseLabel = genLabel(context, "else");
  const endLabel = genLabel(context, "end");

  // Compile test
  const testResult = compileExpression(node.test, builder, context);
  builder.emitBranchTo(OpCodes.BRF, elseLabel);

  // Compile consequent
  const conseqResult = compileExpression(node.consequent, builder, context);
  builder.emitBranchTo(OpCodes.BR, endLabel);

  // Compile alternate
  builder.markLabel(elseLabel);
  const altResult = compileExpression(node.alternate, builder, context);
  
  builder.markLabel(endLabel);

  return {
    maxStackSize: Math.max(testResult.maxStackSize, conseqResult.maxStackSize, altResult.maxStackSize)
  };
}

/**
 * Compile NoneType - direct, no monads
 */
function compileNoneType(
  node: {type: "NoneType"},
  builder: InstructionBuilder
): ExpressionResult {
  builder.emitNullary(OpCodes.LGCU);
  return { maxStackSize: 1 };
}

/**
 * Main expression compiler dispatch - direct, no monads
 */
function compileExpression(
  node: es.Expression | {type: "NoneType"},
  builder: InstructionBuilder,
  context: CompilationContext,
  isTailCall: boolean = false
): ExpressionResult {
  switch (node.type) {
    case "Literal":
      return compileLiteral(node, builder);
      
    case "Identifier":
      return compileIdentifier(node, builder, context);
      
    case "BinaryExpression":
      return compileBinaryExpression(node, builder, context);
      
    case "UnaryExpression":
      return compileUnaryExpression(node, builder, context);
      
    case "CallExpression":
      return compileCallExpression(node, builder, context, isTailCall);
      
    case "ConditionalExpression":
      return compileConditionalExpression(node, builder, context, isTailCall);
      
    case "LogicalExpression":
      // Convert to conditional expression
      if (node.operator === "&&") {
        const conditional: es.ConditionalExpression = {
          type: "ConditionalExpression",
          test: node.left,
          consequent: node.right,
          alternate: { type: "Literal", value: false } as es.Literal,
        };
        return compileConditionalExpression(conditional, builder, context, isTailCall);
      } else if (node.operator === "||") {
        const conditional: es.ConditionalExpression = {
          type: "ConditionalExpression",
          test: node.left,
          consequent: { type: "Literal", value: true } as es.Literal,
          alternate: node.right,
        };
        return compileConditionalExpression(conditional, builder, context, isTailCall);
      }
      throw new Error(`Unsupported logical operator: ${node.operator}`);
      
    case "ArrowFunctionExpression":
      // Get function info from analysis
      const arrowFunctionInfo = context.analysis.functionNodes.get(node);
      if (!arrowFunctionInfo) {
        throw new Error(`Arrow function not found in analysis data`);
      }
      
      // Emit function creation instruction
      builder.emitUnary(OpCodes.NEWC, arrowFunctionInfo.functionIndex);
      
      return { maxStackSize: 1 };
      
    case "NoneType":
      return compileNoneType(node, builder);
    
    default:
      throw new Error(`Unsupported expression type: ${node.type}`);
  }
}

// ============================================================================
// Statement Compilers
// ============================================================================

function compileStatement(
  node: es.Statement,
  builder: InstructionBuilder,
  context: CompilationContext,
  isLastStatement: boolean = false
): ExpressionResult {
  switch (node.type) {
    case "ExpressionStatement":
      return compileExpression(node.expression, builder, context);
      
    case "ReturnStatement":
      if (!node.argument) {
        builder.emitNullary(OpCodes.LGCU);
        builder.emitNullary(OpCodes.RETG);
        return { maxStackSize: 1 };
      }
      const result = compileExpression(node.argument, builder, context);
      builder.emitNullary(OpCodes.RETG);
      return result;
      
    case "VariableDeclaration":
      if (node.kind !== "var" && node.kind !== "const") {
        throw new Error("Invalid declaration kind");
      }

      // TODO: if node.kind == "const", we need to compile-time check 
      // no other assignment in scope

      const id = node.declarations[0].id as es.Identifier;
      const resolved = context.analysis.resolvedIdentifiers.get(id);
      if (!resolved) {
        throw new UndefinedVariable(id.name, id);
      }
      
      const initResult = compileExpression(node.declarations[0].init as es.Expression, builder, context);
      
      if (resolved.envLevel === 0) {
        builder.emitUnary(OpCodes.STLG, resolved.index);
      } else {
        builder.emitBinary(OpCodes.STPG, resolved.index, resolved.envLevel);
      }
      
      builder.emitNullary(OpCodes.LGCU);
      return initResult;
    
    case "FunctionDeclaration":
      if (node.id === null) {
        throw new Error(
          'Encountered a FunctionDeclaration node without an identifier. This should have been caught when parsing.'
        );
      }
      
      // Get function info from analysis
      const functionInfo = context.analysis.functionNodes.get(node);
      if (!functionInfo) {
        throw new Error(`Function ${node.id.name} not found in analysis data`);
      }
      
      // Emit function creation instruction
      builder.emitUnary(OpCodes.NEWC, functionInfo.functionIndex);
      
      // Store the function in the local variable
      if (functionInfo.storageIndex !== undefined) {
        builder.emitUnary(OpCodes.STLG, functionInfo.storageIndex);
        builder.emitNullary(OpCodes.LGCU);
      } else {
        throw new Error(`Function ${node.id.name} missing storage index information`);
      }
      
      return { maxStackSize: 1 };

    default:
      throw new Error(`Unsupported statement type: ${node.type}`);
  }
}

/**
 * Compile a block of statements
 */
function compileStatements(
  statements: es.Statement[],
  builder: InstructionBuilder,
  context: CompilationContext
): ExpressionResult {
  if (statements.length === 0) {
    builder.emitNullary(OpCodes.LGCU);
    return { maxStackSize: 1 };
  }

  let maxStackSize = 0;
  
  for (let i = 0; i < statements.length; i++) {
    const result = compileStatement(statements[i], builder, context, i === statements.length - 1);
    maxStackSize = Math.max(maxStackSize, result.maxStackSize);
    
    // Assumption: every statement/expression leaves exactly one value.
    // Earlier statement results are not needed and would otherwise accumulate,
    // breaking block-level stack balance. Pop N-1 intermediates so only the last
    // statement's value remains (the block result). Any leftovers indicate a
    // compiler emission bug (e.g. extra LGCU or unconsumed operands).
    if (i < statements.length - 1) {
      builder.emitNullary(OpCodes.POPG);
    }
  }

  return { maxStackSize };
}

// ============================================================================
// Composition Utilities
// ============================================================================

/**
 * Compile a single function and return the builder with function metadata
 */
export function compileFunctionToBuilder(
  functionInfo: FunctionInfo,
  context: CompilationContext
): { builder: InstructionBuilder; maxStackSize: number; envSize: number; numArgs: number } {
  const builder = new InstructionBuilder();
  const functionContext = { ...context, isTopLevel: false };

  // Compile function body
  const result = compileStatements(
    functionInfo.ast.body as es.Statement[],
    builder,
    functionContext
  );

  // Add return if needed (functions should always return something)
  builder.emitNullary(OpCodes.RETG);

  return { 
    builder, 
    maxStackSize: result.maxStackSize,
    envSize: functionInfo.envSize,
    numArgs: functionInfo.numArgs
  };
}



// ============================================================================
// Main Compiler Entry Point
// ============================================================================

/**
 * Compile a program
 */
export function compileDirect(
  program: es.Program,
  prelude?: SVMProgram,
  vmInternalFunctions?: string[]
): SVMProgram {
  // Step 1: Analysis pass
  const analysis = analyzeProgram(program, PRIMITIVE_FUNCTIONS, vmInternalFunctions);

  // Step 2: Create compilation context
  const context: CompilationContext = {
    analysis,
    isTopLevel: true,
    labelCounter: 0,
  };

  // Step 3: Compile all functions to separate builders
  const svmFunctions: SVMFunction[] = [];
  
  // Add prelude functions if provided
  if (prelude) {
    svmFunctions.push(...prelude[1]);
  }
  
  // Compile user-defined functions first
  for (const functionInfo of analysis.functions) {
    const { builder, maxStackSize, envSize, numArgs } = compileFunctionToBuilder(functionInfo, context);
    const svmFunction = builder.toSVMFunction(maxStackSize, envSize, numArgs);
    svmFunctions.push(svmFunction);
  }

  // Compile main function last
  const { builder: mainBuilder, maxStackSize: mainStackSize, envSize: mainEnvSize, numArgs: mainNumArgs } = 
    compileFunctionToBuilder(analysis.mainFunction, context);
  const mainSVMFunction = mainBuilder.toSVMFunction(mainStackSize, mainEnvSize, mainNumArgs);
  svmFunctions.push(mainSVMFunction);

  // Step 4: Create program structure
  const entryPointIndex = analysis.mainFunction.functionIndex;
  
  return [entryPointIndex, svmFunctions];
}
