import * as es from "estree";
import { UNKNOWN_LOCATION } from "../errors/runtimeSourceError";
import { ConstAssignment, UndefinedVariable } from "../errors/errors";
import { CONSTANT_PRIMITIVES, PRIMITIVE_FUNCTIONS } from "../stdlib/vm-prelude";

// Import our new functional modules
import {
  CompilerM,
  pure,
  chain,
  map,
  then,
  ask,
  getState,
  modifyState,
  emitNullary,
  emitUnary,
  emitBinary,
  genLabel,
  markLabel,
  emitBranchTo,
  withStackTracking,
  sequence,
  sequence_,
  runCompilerM,
  createReader,
  createInitialState,
} from "./compiler-monad";

import {
  Environment,
  ResolvedSymbol,
  AnalysisResult,
  FunctionInfo,
  analyzeProgram,
  resolveIdentifier,
  lookupSymbol,
} from "./compiler-environment";

import {
  InstructionSink,
  BufferedInstructionSink,
  InstructionSinkFactory,
} from "./compiler-sink";

import { Program, Instruction } from "./svml-compiler";
import OpCodes from "./opcodes";

// ============================================================================
// Functional Compiler Implementation
// ============================================================================

/**
 * Compilation context that includes analysis results
 */
type CompilationContext = {
  analysis: AnalysisResult;
  isTopLevel: boolean;
};

/**
 * Result of compiling an expression/statement
 */
type ExpressionResult = {
  stackEffect: number;
  needsReturn: boolean;
};

// ============================================================================
// Core Compiler Functions
// ============================================================================

/**
 * Compile a literal value
 */
const compileLiteral = (node: es.Literal): CompilerM<ExpressionResult> =>
  chain(ask, (reader) => {
    const value = node.value;

    if (value === null) {
      return chain(emitNullary(reader.opcodes.LGCN, 1), () =>
        pure({ stackEffect: 1, needsReturn: false })
      );
    } else if ('bigint' in node) {
      // Handle BigIntLiteral
      const numValue = Number(node.bigint);
      const opcode = Number.isInteger(numValue) && 
                    -2_147_483_648 <= numValue && 
                    numValue <= 2_147_483_647
        ? reader.opcodes.LGCI
        : reader.opcodes.LGCF64;
      
      return chain(emitUnary(opcode, numValue, 1), () =>
        pure({ stackEffect: 1, needsReturn: false })
      );
    } else {
      // Handle SimpleLiteral
      switch (typeof value) {
        case "boolean":
          const opcode = value ? reader.opcodes.LGCB1 : reader.opcodes.LGCB0;
          return chain(emitNullary(opcode, 1), () =>
            pure({ stackEffect: 1, needsReturn: false })
          );
          
        case "number":
          return chain(emitUnary(reader.opcodes.LGCF64, value, 1), () =>
            pure({ stackEffect: 1, needsReturn: false })
          );
          
        case "string":
          return chain(emitUnary(reader.opcodes.LGCS, value, 1), () =>
            pure({ stackEffect: 1, needsReturn: false })
          );
          
        default:
          throw new Error("Unsupported literal type");
      }
    }
  });

/**
 * Compile an identifier reference
 */
const compileIdentifier = (
  node: es.Identifier,
  context: CompilationContext
): CompilerM<ExpressionResult> =>
  chain(ask, (reader) => {
    // Try to get pre-resolved symbol
    const resolved = context.analysis.resolvedIdentifiers.get(node);
    
    if (resolved) {
      // Use pre-resolved information
      if (resolved.type === "primitive") {
        return chain(emitUnary(reader.opcodes.NEWCP, resolved.index, 1), () =>
          pure({ stackEffect: 1, needsReturn: false })
        );
      } else if (resolved.type === "internal") {
        return chain(emitUnary(reader.opcodes.NEWCV, resolved.index, 1), () =>
          pure({ stackEffect: 1, needsReturn: false })
        );
      } else if (resolved.envLevel === 0) {
        return chain(emitUnary(reader.opcodes.LDLG, resolved.index, 1), () =>
          pure({ stackEffect: 1, needsReturn: false })
        );
      } else {
        return chain(emitBinary(reader.opcodes.LDPG, resolved.index, resolved.envLevel, 1), () =>
          pure({ stackEffect: 1, needsReturn: false })
        );
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
        return chain(emitUnary(reader.opcodes.LGCF32, value, 1), () =>
          pure({ stackEffect: 1, needsReturn: false })
        );
      } else if (value === undefined) {
        return chain(emitNullary(reader.opcodes.LGCU, 1), () =>
          pure({ stackEffect: 1, needsReturn: false })
        );
      } else {
        throw new Error("Unknown primitive constant");
      }
    }
  });

/**
 * Compile a binary expression
 */
const compileBinaryExpression = (
  node: es.BinaryExpression,
  context: CompilationContext
): CompilerM<ExpressionResult> =>
  chain(ask, (reader) => {
    const VALID_BINARY_OPERATORS = new Map([
      ["+", reader.opcodes.ADDG],
      ["-", reader.opcodes.SUBG],
      ["*", reader.opcodes.MULG],
      ["/", reader.opcodes.DIVG],
      ["%", reader.opcodes.MODG],
      ["<", reader.opcodes.LTG],
      [">", reader.opcodes.GTG],
      ["<=", reader.opcodes.LEG],
      [">=", reader.opcodes.GEG],
      ["===", reader.opcodes.EQG],
      ["!==", reader.opcodes.NEQG],
    ]);

    const opcode = VALID_BINARY_OPERATORS.get(node.operator);
    if (!opcode) {
      throw new Error(`Unsupported binary operator: ${node.operator}`);
    }

    return chain(
      withStackTracking(compileExpression(node.left as es.Expression, context)),
      ({ result: leftResult, stackSize: leftStack }) =>
        chain(
          withStackTracking(compileExpression(node.right, context)),
          ({ result: rightResult, stackSize: rightStack }) =>
            chain(emitNullary(opcode, 0), () =>
              pure({
                stackEffect: Math.max(leftStack, 1 + rightStack),
                needsReturn: false,
              })
            )
        )
    );
  });

/**
 * Compile a unary expression
 */
const compileUnaryExpression = (
  node: es.UnaryExpression,
  context: CompilationContext
): CompilerM<ExpressionResult> =>
  chain(ask, (reader) => {
    const VALID_UNARY_OPERATORS = new Map([
      ["!", reader.opcodes.NOTG],
      ["-", reader.opcodes.NEGG],
    ]);

    const opcode = VALID_UNARY_OPERATORS.get(node.operator);
    if (!opcode) {
      throw new Error(`Unsupported unary operator: ${node.operator}`);
    }

    return chain(
      withStackTracking(compileExpression(node.argument, context)),
      ({ result, stackSize }) =>
        chain(emitNullary(opcode, 0), () =>
          pure({ stackEffect: stackSize, needsReturn: false })
        )
    );
  });

/**
 * Compile a call expression
 */
const compileCallExpression = (
  node: es.CallExpression,
  context: CompilationContext,
  isTailCall: boolean = false
): CompilerM<ExpressionResult> =>
  chain(ask, (reader) => {
    if (node.callee.type !== "Identifier") {
      throw new Error("Unsupported call expression");
    }

    const callee = node.callee as es.Identifier;

    // Special case for __py_adder
    if (callee.name === "__py_adder") {
      // Compile both arguments and track the maximum stack depth
      return chain(
        compileExpression(node.arguments[0] as es.Expression, context),
        (arg1Result) =>
          chain(
            compileExpression(node.arguments[1] as es.Expression, context),
            (arg2Result) =>
              chain(emitNullary(reader.opcodes.ADDG, -1), () => // ADDG pops 2, pushes 1, so net -1
                pure({ stackEffect: Math.max(arg1Result.stackEffect, arg2Result.stackEffect + 1), needsReturn: false })
              )
          )
      );
    }

    const resolved = context.analysis.resolvedIdentifiers.get(callee);
    if (!resolved) {
      throw new UndefinedVariable(callee.name, callee);
    }

    // Compile arguments first
    const compileArgs = (): CompilerM<{ maxStackSize: number }> => {
      const compileArg = (expr: es.Expression, index: number): CompilerM<number> =>
        chain(
          withStackTracking(compileExpression(expr, context)),
          ({ stackSize }) => pure(index + stackSize)
        );

      return chain(
        sequence(node.arguments.map((arg, i) => compileArg(arg as es.Expression, i))),
        (stackSizes) => pure({ maxStackSize: Math.max(...stackSizes, 0) })
      );
    };

    return chain(compileArgs(), ({ maxStackSize: argStackSize }) => {
      // Load function if needed
      const loadFunction = (): CompilerM<number> => {
        if (resolved.type === "primitive" || resolved.type === "internal") {
          return pure(0); // No function loading needed
        } else if (resolved.envLevel === 0) {
          return chain(emitUnary(reader.opcodes.LDLG, resolved.index, 1), () =>
            pure(1)
          );
        } else {
          return chain(
            emitBinary(reader.opcodes.LDPG, resolved.index, resolved.envLevel, 1),
            () => pure(1)
          );
        }
      };

      return chain(loadFunction(), (functionStackEffect) => {
        // Emit call instruction
        const emitCall = (): CompilerM<void> => {
          const numArgs = node.arguments.length;
          
          if (resolved.type === "primitive") {
            const opcode = isTailCall ? reader.opcodes.CALLTP : reader.opcodes.CALLP;
            return emitBinary(opcode, resolved.index, numArgs);
          } else if (resolved.type === "internal") {
            const opcode = isTailCall ? reader.opcodes.CALLTV : reader.opcodes.CALLV;
            return emitBinary(opcode, resolved.index, numArgs);
          } else {
            const opcode = isTailCall ? reader.opcodes.CALLT : reader.opcodes.CALL;
            return emitUnary(opcode, numArgs);
          }
        };

        return chain(emitCall(), () =>
          pure({
            stackEffect: Math.max(functionStackEffect, argStackSize, 1),
            needsReturn: false,
          })
        );
      });
    });
  });

/**
 * Compile a conditional expression
 */
const compileConditionalExpression = (
  node: es.ConditionalExpression,
  context: CompilationContext,
  isTailCall: boolean = false
): CompilerM<ExpressionResult> =>
  chain(ask, (reader) =>
    chain(genLabel("else"), (elseLabel) =>
      chain(genLabel("end"), (endLabel) =>
        chain(
          withStackTracking(compileExpression(node.test, context)),
          ({ result: testResult, stackSize: testStack }) =>
            chain(emitBranchTo(reader.opcodes.BRF, elseLabel), () =>
              chain(
                withStackTracking(
                  compileExpression(node.consequent, context)
                ),
                ({ result: conseqResult, stackSize: conseqStack }) =>
                  chain(emitBranchTo(reader.opcodes.BR, endLabel), () =>
                    chain(markLabel(elseLabel), () =>
                      chain(
                        withStackTracking(
                          compileExpression(node.alternate, context)
                        ),
                        ({ result: altResult, stackSize: altStack }) =>
                          chain(markLabel(endLabel), () =>
                            pure({
                              stackEffect: Math.max(testStack, conseqStack, altStack),
                              needsReturn: false,
                            })
                          )
                      )
                    )
                  )
              )
            )
        )
      )
    )
  );

/**
 * Main expression compiler dispatch
 */
const compileExpression = (
  node: es.Expression | {type: "NoneType"},
  context: CompilationContext,
  isTailCall: boolean = false
): CompilerM<ExpressionResult> => {
  switch (node.type) {
    case "Literal":
      return compileLiteral(node);
      
    case "Identifier":
      return compileIdentifier(node, context);
      
    case "BinaryExpression":
      return compileBinaryExpression(node, context);
      
    case "UnaryExpression":
      return compileUnaryExpression(node, context);
      
    case "CallExpression":
      return compileCallExpression(node, context, isTailCall);
      
    case "ConditionalExpression":
      return compileConditionalExpression(node, context, isTailCall);
      
    case "LogicalExpression":
      // Convert to conditional expression
      if (node.operator === "&&") {
        const conditional: es.ConditionalExpression = {
          type: "ConditionalExpression",
          test: node.left,
          consequent: node.right,
          alternate: { type: "Literal", value: false } as es.Literal,
        };
        return compileConditionalExpression(conditional, context, isTailCall);
      } else if (node.operator === "||") {
        const conditional: es.ConditionalExpression = {
          type: "ConditionalExpression",
          test: node.left,
          consequent: { type: "Literal", value: true } as es.Literal,
          alternate: node.right,
        };
        return compileConditionalExpression(conditional, context, isTailCall);
      }
      throw new Error(`Unsupported logical operator: ${node.operator}`);
      
    case "NoneType":
        return compileNoneType(node);
    
    default:
      throw new Error(`Unsupported expression type: ${node.type}`);
  }
};

const compileNoneType = (node: {type: "NoneType"}): CompilerM<ExpressionResult> =>
  chain(emitNullary(OpCodes.LGCU, 1), () =>
    pure({ stackEffect: 1, needsReturn: false })
  );

/**
 * Compile a statement
 */
const compileStatement = (
  node: es.Statement,
  context: CompilationContext,
  isLastStatement: boolean = false
): CompilerM<ExpressionResult> => {
  switch (node.type) {
    case "ExpressionStatement":
      return compileExpression(node.expression, context);
      
    case "ReturnStatement":
      if (!node.argument) {
        return chain(emitNullary(OpCodes.LGCU, 1), () =>
          chain(emitNullary(OpCodes.RETG), () =>
            pure({ stackEffect: 1, needsReturn: true })
          )
        );
      }
      return chain(
        withStackTracking(compileExpression(node.argument, context)),
        ({ result, stackSize }) =>
          chain(emitNullary(OpCodes.RETG), () =>
            pure({ stackEffect: stackSize, needsReturn: true })
          )
      );
      
    case "VariableDeclaration":
      if (node.kind !== "var") {
        throw new Error("Invalid declaration kind");
      }
      
      const id = node.declarations[0].id as es.Identifier;
      const resolved = context.analysis.resolvedIdentifiers.get(id);
      if (!resolved) {
        throw new UndefinedVariable(id.name, id);
      }
      
      return chain(
        withStackTracking(
          compileExpression(node.declarations[0].init as es.Expression, context)
        ),
        ({ result, stackSize }) => {
          const storeOp = resolved.envLevel === 0 
            ? emitUnary(OpCodes.STLG, resolved.index)
            : emitBinary(OpCodes.STPG, resolved.index, resolved.envLevel);
            
          return chain(storeOp, () =>
            chain(emitNullary(OpCodes.LGCU, 1), () =>
              pure({ stackEffect: stackSize, needsReturn: false })
            )
          );
        }
      );
      
    default:
      throw new Error(`Unsupported statement type: ${node.type}`);
  }
};

/**
 * Compile a block of statements
 */
const compileStatements = (
  statements: es.Statement[],
  context: CompilationContext
): CompilerM<ExpressionResult> => {
  if (statements.length === 0) {
    return chain(emitNullary(OpCodes.LGCU, 1), () =>
      pure({ stackEffect: 1, needsReturn: false })
    );
  }

  const compileStmt = (stmt: es.Statement, index: number): CompilerM<number> =>
    chain(
      withStackTracking(
        compileStatement(stmt, context, index === statements.length - 1)
      ),
      ({ result, stackSize }) => {
        // Pop intermediate results except for the last statement
        if (index < statements.length - 1) {
          return chain(emitNullary(OpCodes.POPG), () => pure(stackSize));
        }
        return pure(stackSize);
      }
    );

  return chain(
    sequence(statements.map((stmt, i) => compileStmt(stmt, i))),
    (stackSizes) =>
      pure({
        stackEffect: Math.max(...stackSizes, 0),
        needsReturn: false,
      })
  );
};

/**
 * Compile a single function
 */
const compileFunction = (
  functionInfo: FunctionInfo,
  context: CompilationContext,
  sink: InstructionSink
): CompilerM<void> => {
  const functionContext = { ...context, isTopLevel: false };

  return (reader, state, builder) => {
    // Begin function in sink
    sink.beginFunction(
      functionInfo.functionIndex,
      functionInfo.envSize,
      functionInfo.numArgs
    );

    // Compile function body
    const bodyCompilation = compileStatements(
      functionInfo.ast.body as es.Statement[],
      functionContext
    );

    const result = bodyCompilation(reader, state, builder);

    // Add return if needed
    if (!result.value.needsReturn) {
      builder.emitNullary(OpCodes.RETG);
    }

    // Transfer instructions to sink
    const instructions = builder.build();
    for (const instruction of instructions) {
      sink.emit(instruction);
    }

    // End function in sink
    sink.endFunction(state.maxStackSize);

    // Reset builder for next function
    builder.reset();
    state.maxStackSize = 0;

    return { value: undefined, maxStackSize: result.maxStackSize };
  };
};

// ============================================================================
// Main Compiler Entry Point
// ============================================================================

/**
 * Compile a program using the functional approach
 */
export const compileFunctional = (
  program: es.Program,
  prelude?: Program,
  vmInternalFunctions?: string[]
): Program => {
  // Step 1: Analysis pass
  const analysis = analyzeProgram(program, PRIMITIVE_FUNCTIONS, vmInternalFunctions);

  // Step 2: Create compilation context
  const context: CompilationContext = {
    analysis,
    isTopLevel: true,
  };

  // Step 3: Create instruction sink
  const sink = InstructionSinkFactory.createBuffered();

  // Step 4: Compile all functions
  const reader = createReader();
  let state = createInitialState();

  // Compile user-defined functions first
  for (const functionInfo of analysis.functions) {
    const compilation = compileFunction(functionInfo, context, sink);
    runCompilerM(compilation, reader, state);
    state = createInitialState(); // Reset for each function
  }

  // Compile main function last
  const mainCompilation = compileFunction(analysis.mainFunction, context, sink);
  runCompilerM(mainCompilation, reader, state);

  // Step 5: Finalize program
  const entryPointIndex = analysis.mainFunction.functionIndex;
  return sink.finalize(entryPointIndex);
};
