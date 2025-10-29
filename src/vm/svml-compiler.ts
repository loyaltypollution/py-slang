import { StmtNS, ExprNS } from "../ast-types";
import { Token } from "../tokenizer";
import { TokenType } from "../tokens";
import { PRIMITIVE_FUNCTIONS } from "./sinter-primitives";
import { SVMProgram, SVMFunction } from "./types";
import { FunctionBuilder } from "./FunctionBuilder";
import OpCodes from "./opcodes";
import { FunctionEnvironments, Environment, Resolver } from "../resolver";
import { InstrumentationTracker, InstrumentationConfig, DEFAULT_INSTRUMENTATION_CONFIG } from "./instrumentation";

// Fast compiler annotations for maximum performance
interface CompilerAnnotation {
  slot: number; // Variable slot index within environment
  envLevel: number; // Environment nesting level (0 = local)
  isPrimitive: boolean; // True if this is a builtin function
  primitiveIndex?: number; // Index in PRIMITIVE_FUNCTIONS if isPrimitive
}

export type ExpressionResult = {
  maxStackSize: number;
};

/**
 * SVML Compiler implementing visitor interface
 */
export class SVMLCompiler
  implements StmtNS.Visitor<ExpressionResult>, ExprNS.Visitor<ExpressionResult>
{
  private builder: FunctionBuilder;
  private currentEnvironment: Environment;
  private functionEnvironments: FunctionEnvironments;
  private isTailCall: boolean;

  // Ultra-fast annotation cache (no string lookups during compilation)
  private tokenAnnotations = new WeakMap<Token, CompilerAnnotation>();
  // Per-environment slot assignment for variables
  private envSlotCounters = new WeakMap<Environment, number>();
  private envSlotMaps = new WeakMap<Environment, Map<string, number>>();

  // Instrumentation tracker for recursion detection and memoization
  private instrumentation: InstrumentationTracker;

  constructor(
    currentEnvironment: Environment,
    functionEnvironments: FunctionEnvironments,
    builder: FunctionBuilder,
    instrumentation?: InstrumentationTracker
  ) {
    this.builder = builder;
    this.currentEnvironment = currentEnvironment;
    this.functionEnvironments = functionEnvironments;
    this.isTailCall = false;
    this.instrumentation = instrumentation || new InstrumentationTracker();
  }

  /**
   * Create SVMLCompiler from program AST
   */
  static fromProgram(program: StmtNS.FileInput): SVMLCompiler {
    const resolver = new Resolver("", program);
    const functionEnvironments = resolver.resolveEnvironments(program);
    const mainEnv = functionEnvironments.get(program);
    if (!mainEnv) {
      throw new Error("Main program environment not found");
    }
    FunctionBuilder.resetIndex();
    const builder = new FunctionBuilder(0);
    return new SVMLCompiler(mainEnv, functionEnvironments, builder);
  }

  fromFunctionNode(node: StmtNS.FunctionDef | ExprNS.Lambda | ExprNS.MultiLambda): SVMLCompiler {
    const nextEnvironment = this.functionEnvironments.get(node);
    if (!nextEnvironment) {
      throw new Error(`Function environment not found`);
    }
    for (const param of node.parameters) {
        nextEnvironment.lookupNameCurrentEnvWithError(param);
    }
    const numArgs = node.parameters.length;
    const builder = this.builder.createChildBuilder(numArgs);
    return new SVMLCompiler(nextEnvironment, this.functionEnvironments, builder, this.instrumentation);
  }

  /**
   * Compile entire program and return complete SVMProgram
   */
  compileProgram(program: StmtNS.FileInput): SVMProgram {
    // Compile main program statements
    this.compile(program);

    // Get all builders from the hierarchy
    const allBuilders = this.builder.getAllBuilders(true);

    // Convert each builder to SVMFunction
    const svmFunctions: SVMFunction[] = [];
    const entryPointIndex = 0; // Main program is always at index 0

    for (const builder of allBuilders) {
      const svmFunction = builder.toSVMFunction();
      svmFunctions.push(svmFunction);
    }

    // Print instrumentation summary
    this.instrumentation.printSummary();
    
    // Detect mutual recursion
    this.instrumentation.detectMutualRecursion();

    return [entryPointIndex, svmFunctions];
  }

  /**
   * Compile a statement or expression and return stack effect
   */
  compile(node: StmtNS.Stmt | ExprNS.Expr): ExpressionResult {
    return node.accept(this);
  }

  /**
   * Get the instrumentation tracker
   */
  getInstrumentation(): InstrumentationTracker {
    return this.instrumentation;
  }

  /**
   * Get or create fast annotation for a token (O(1) lookup via WeakMap)
   */
  private getTokenAnnotation(token: Token): CompilerAnnotation {
    let annotation = this.tokenAnnotations.get(token);
    if (annotation) {
      return annotation;
    }

    const name = token.lexeme;
    const parentEnv = this.currentEnvironment.lookupNameEnv(token);

    // Handle primitive functions
    if (parentEnv === Environment.GlobalEnvironment) {
      const primitiveIndex = PRIMITIVE_FUNCTIONS.get(name);
      if (primitiveIndex === undefined) {
        throw new Error(`Primitive function ${name} not implemented`);
      }
      annotation = {
        slot: primitiveIndex,
        envLevel: 0,
        isPrimitive: true,
        primitiveIndex,
      };
    } else if (parentEnv != null) {
      // Handle user-declared variables
      const envLevel = this.currentEnvironment.lookupName(token);
      const slot = this.getOrAssignSlot(parentEnv, name);

      annotation = {
        slot,
        envLevel,
        isPrimitive: false,
      };
    } else {
      throw new Error(`Variable ${name} not found in environment`);
    }

    this.tokenAnnotations.set(token, annotation);
    return annotation;
  }

  /**
   * Assign variable slot in environment (O(1) with WeakMap)
   */
  private getOrAssignSlot(env: Environment, name: string): number {
    let slotMap = this.envSlotMaps.get(env);
    if (!slotMap) {
      slotMap = new Map();
      this.envSlotMaps.set(env, slotMap);
      this.envSlotCounters.set(env, 0);
    }

    let slot = slotMap.get(name);
    if (slot === undefined) {
      slot = this.envSlotCounters.get(env)!;
      slotMap.set(name, slot);
      this.envSlotCounters.set(env, slot + 1);
      this.builder.noteSymbolUsed();
    }
    return slot;
  }

  private emitLoadSymbol(token: Token): ExpressionResult {
    const annotation = this.getTokenAnnotation(token);

    if (annotation.isPrimitive) {
      return { maxStackSize: 0 };
    }
    if (annotation.envLevel === 0) {
      this.builder.emitUnary(OpCodes.LDLG, annotation.slot);
    } else {
      this.builder.emitBinary(
        OpCodes.LDPG,
        annotation.slot,
        annotation.envLevel
      );
    }
    return { maxStackSize: 1 };
  }

  private emitStoreSymbol(token: Token): void {
    const annotation = this.getTokenAnnotation(token);

    if (annotation.isPrimitive) {
      throw new Error(`Cannot assign to primitive symbol: ${token.lexeme}`);
    }

    if (annotation.envLevel === 0) {
      this.builder.emitUnary(OpCodes.STLG, annotation.slot);
    } else {
      this.builder.emitBinary(
        OpCodes.STPG,
        annotation.slot,
        annotation.envLevel
      );
    }
  }

  private emitFunctionCall(token: Token, numArgs: number): void {
    const annotation = this.getTokenAnnotation(token);

    if (annotation.isPrimitive) {
      const primitiveOpcode = this.isTailCall ? OpCodes.CALLTP : OpCodes.CALLP;
      this.builder.emitPrimitiveCall(
        primitiveOpcode,
        annotation.primitiveIndex!,
        numArgs
      );
    } else {
      const userOpcode = this.isTailCall ? OpCodes.CALLT : OpCodes.CALL;
      this.builder.emitCall(userOpcode, numArgs);
    }
  }

  // ========================================================================
  // Expression Visitor Methods
  // ========================================================================

  visitLiteralExpr(expr: ExprNS.Literal): ExpressionResult {
    const value = expr.value;

    if (value === null) {
      this.builder.emitNullary(OpCodes.LGCN);
    } else {
      switch (typeof value) {
        case "boolean":
          this.builder.emitNullary(value ? OpCodes.LGCB1 : OpCodes.LGCB0);
          break;
        case "number":
          if (
            Number.isInteger(value) &&
            -2_147_483_648 <= value &&
            value <= 2_147_483_647
          ) {
            this.builder.emitUnary(OpCodes.LGCI, value);
          } else {
            this.builder.emitUnary(OpCodes.LGCF64, value);
          }
          break;
        case "string":
          this.builder.emitUnary(OpCodes.LGCS, value);
          break;
        default:
          throw new Error("Unsupported literal type");
      }
    }

    return { maxStackSize: 1 };
  }

  visitBigIntLiteralExpr(expr: ExprNS.BigIntLiteral): ExpressionResult {
    const numValue = Number(expr.value);
    if (
      Number.isInteger(numValue) &&
      -2_147_483_648 <= numValue &&
      numValue <= 2_147_483_647
    ) {
      this.builder.emitUnary(OpCodes.LGCI, numValue);
    } else {
      this.builder.emitUnary(OpCodes.LGCF64, numValue);
    }

    return { maxStackSize: 1 };
  }

  visitComplexExpr(expr: ExprNS.Complex): ExpressionResult {
    // For now, treat complex numbers as objects
    // This would need proper SVML support for complex numbers
    throw new Error("Complex numbers not yet supported in SVML compiler");
  }

  visitVariableExpr(expr: ExprNS.Variable): ExpressionResult {
    this.emitLoadSymbol(expr.name);
    return { maxStackSize: 1 };
  }

  /**
   * Convert Python operator token to SVML binary operator
   */
  private getBinaryOpCode(operator: Token): number {
    switch (operator.type) {
      case TokenType.PLUS:
        return OpCodes.ADDG;
      case TokenType.MINUS:
        return OpCodes.SUBG;
      case TokenType.STAR:
        return OpCodes.MULG;
      case TokenType.SLASH:
        return OpCodes.DIVG;
      case TokenType.PERCENT:
        return OpCodes.MODG;
      default:
        throw new Error(`Unsupported binary operator: ${operator.lexeme}`);
    }
  }

  /**
   * Convert Python comparison operator token to SVML binary operator
   */
  private getCompareOpCode(operator: Token): number {
    switch (operator.type) {
      case TokenType.LESS:
        return OpCodes.LTG;
      case TokenType.GREATER:
        return OpCodes.GTG;
      case TokenType.LESSEQUAL:
        return OpCodes.LEG;
      case TokenType.GREATEREQUAL:
        return OpCodes.GEG;
      case TokenType.DOUBLEEQUAL:
        return OpCodes.EQG;
      case TokenType.NOTEQUAL:
        return OpCodes.NEQG;
      default:
        throw new Error(`Unsupported comparison operator: ${operator.lexeme}`);
    }
  }

  visitBinaryExpr(expr: ExprNS.Binary): ExpressionResult {
    const opcode = this.getBinaryOpCode(expr.operator);

    // Compile left operand
    const leftResult = this.compile(expr.left);

    // Compile right operand
    const rightResult = this.compile(expr.right);

    // Emit the operation
    this.builder.emitNullary(opcode);

    return {
      maxStackSize: Math.max(
        leftResult.maxStackSize,
        1 + rightResult.maxStackSize
      ),
    };
  }

  visitCompareExpr(expr: ExprNS.Compare): ExpressionResult {
    const opcode = this.getCompareOpCode(expr.operator);

    // Compile left operand
    const leftResult = this.compile(expr.left);

    // Compile right operand
    const rightResult = this.compile(expr.right);

    // Emit the operation
    this.builder.emitNullary(opcode);

    return {
      maxStackSize: Math.max(
        leftResult.maxStackSize,
        1 + rightResult.maxStackSize
      ),
    };
  }

  visitBoolOpExpr(expr: ExprNS.BoolOp): ExpressionResult {
    // Convert to conditional expression
    if (expr.operator.type === TokenType.AND) {
      // left && right -> left ? right : false
      const testResult = this.compile(expr.left);
      const elseLabel = this.builder.emitJump(OpCodes.BRF);

      const conseqResult = this.compile(expr.right);
      const endLabel = this.builder.emitJump(OpCodes.BR);

      this.builder.markLabel(elseLabel);
      this.builder.emitNullary(OpCodes.LGCB0); // false
      const altResult = { maxStackSize: 1 };

      this.builder.markLabel(endLabel);

      return {
        maxStackSize: Math.max(
          testResult.maxStackSize,
          conseqResult.maxStackSize,
          altResult.maxStackSize
        ),
      };
    } else if (expr.operator.type === TokenType.OR) {
      // left || right -> left ? true : right
      const testResult = this.compile(expr.left);
      const elseLabel = this.builder.emitJump(OpCodes.BRF);

      this.builder.emitNullary(OpCodes.LGCB1); // true
      const conseqResult = { maxStackSize: 1 };
      const endLabel = this.builder.emitJump(OpCodes.BR);

      this.builder.markLabel(elseLabel);
      const altResult = this.compile(expr.right);

      this.builder.markLabel(endLabel);

      return {
        maxStackSize: Math.max(
          testResult.maxStackSize,
          conseqResult.maxStackSize,
          altResult.maxStackSize
        ),
      };
    }
    throw new Error(`Unsupported boolean operator: ${expr.operator.lexeme}`);
  }

  visitUnaryExpr(expr: ExprNS.Unary): ExpressionResult {
    let opcode: number;

    switch (expr.operator.type) {
      case TokenType.NOT:
        opcode = OpCodes.NOTG;
        break;
      case TokenType.MINUS:
        opcode = OpCodes.NEGG;
        break;
      case TokenType.PLUS:
        // Unary plus - for now just return the operand
        return this.compile(expr.right);
      default:
        throw new Error(`Unsupported unary operator: ${expr.operator.lexeme}`);
    }

    // Compile the operand
    const operandResult = this.compile(expr.right);

    // Emit the operation
    this.builder.emitNullary(opcode);

    return { maxStackSize: operandResult.maxStackSize };
  }

  visitCallExpr(expr: ExprNS.Call): ExpressionResult {
    // Instrumentation: record this call
    this.instrumentation.recordCall(expr);
    
    if (!(expr.callee instanceof ExprNS.Variable)) {
      throw new Error(
        "Unsupported call expression: callee must be an identifier"
      );
    }

    const callee: ExprNS.Variable = expr.callee;

    // Load function if needed
    const { maxStackSize: functionStackEffect } = this.emitLoadSymbol(callee.name);

    // Compile arguments
    let maxArgStackSize = 0;
    for (let i = 0; i < expr.args.length; i++) {
      const argResult = this.compile(expr.args[i]);
      maxArgStackSize = Math.max(maxArgStackSize, i + argResult.maxStackSize);
    }

    // Emit call instruction
    const numArgs = expr.args.length;
    this.emitFunctionCall(callee.name, numArgs);

    return {
      maxStackSize: functionStackEffect + maxArgStackSize,
    };
  }

  visitTernaryExpr(expr: ExprNS.Ternary): ExpressionResult {
    // Compile test
    const testResult = this.compile(expr.predicate);
    const elseLabel = this.builder.emitJump(OpCodes.BRF);

    // Compile consequent
    const conseqResult = this.compile(expr.consequent);
    const endLabel = this.builder.emitJump(OpCodes.BR);

    // Compile alternate
    this.builder.markLabel(elseLabel);
    const altResult = this.compile(expr.alternative);

    this.builder.markLabel(endLabel);

    return {
      maxStackSize: Math.max(
        testResult.maxStackSize,
        conseqResult.maxStackSize,
        altResult.maxStackSize
      ),
    };
  }

  visitNoneExpr(expr: ExprNS.None): ExpressionResult {
    this.builder.emitNullary(OpCodes.LGCU);
    return { maxStackSize: 1 };
  }

  visitLambdaExpr(expr: ExprNS.Lambda): ExpressionResult {
    const ast: StmtNS.Stmt = new StmtNS.Return(
      expr.startToken,
      expr.endToken,
      expr.body
    );
    
    // Compile lambda body in child environment
    const compiler = this.fromFunctionNode(expr);
    
    // Instrumentation: enter lambda
    this.instrumentation.enterFunction(expr, compiler.builder.getFunctionIndex());
    
    const { maxStackSize } = compiler.compile(ast);
    
    // Instrumentation: exit lambda
    this.instrumentation.exitFunction();
    
    // Add return if needed (functions should always return something)
    compiler.builder.emitNullary(OpCodes.RETG);

    // Emit function creation instruction in current environment
    this.builder.emitUnary(OpCodes.NEWC, compiler.builder.getFunctionIndex());

    return { maxStackSize: Math.max(maxStackSize, 1) };
  }

  visitMultiLambdaExpr(expr: ExprNS.MultiLambda): ExpressionResult {
    const ast: StmtNS.Stmt[] = expr.body;

    // Compile lambda body in child environment
    const compiler = this.fromFunctionNode(expr);
    
    // Instrumentation: enter multi-lambda
    this.instrumentation.enterFunction(expr, compiler.builder.getFunctionIndex());
    
    const { maxStackSize } = compiler.compileStatements(ast);
    
    // Instrumentation: exit multi-lambda
    this.instrumentation.exitFunction();
    
    // Add return if needed (functions should always return something)
    compiler.builder.emitNullary(OpCodes.RETG);

    // Emit function creation instruction in current environment
    this.builder.emitUnary(OpCodes.NEWC, compiler.builder.getFunctionIndex());

    return { maxStackSize: Math.max(maxStackSize, 1) };
  }

  visitGroupingExpr(expr: ExprNS.Grouping): ExpressionResult {
    return this.compile(expr.expression);
  }

  visitSimpleExprStmt(stmt: StmtNS.SimpleExpr): ExpressionResult {
    return this.compile(stmt.expression);
  }

  visitReturnStmt(stmt: StmtNS.Return): ExpressionResult {
    if (!stmt.value) {
      this.builder.emitNullary(OpCodes.LGCU);
      this.builder.emitNullary(OpCodes.RETG);
      return { maxStackSize: 1 };
    }
    const result = this.compile(stmt.value);
    this.builder.emitNullary(OpCodes.RETG);
    return result;
  }

  visitAssignStmt(stmt: StmtNS.Assign): ExpressionResult {
    const initResult = this.compile(stmt.value);

    // Emit store instruction (will handle primitive check internally)
    this.emitStoreSymbol(stmt.name);

    this.builder.emitNullary(OpCodes.LGCU);
    return initResult;
  }

  visitFunctionDefStmt(stmt: StmtNS.FunctionDef): ExpressionResult {
    const ast: StmtNS.Stmt[] = stmt.body;

    // Compile function body in child environment
    const childCompiler = this.fromFunctionNode(stmt);
    
    // Instrumentation: enter function
    this.instrumentation.enterFunction(stmt, childCompiler.builder.getFunctionIndex());
    
    const { maxStackSize } = childCompiler.compileStatements(ast);
    
    // Instrumentation: exit function
    this.instrumentation.exitFunction();
    
    // Add return if needed (functions should always return something)
    childCompiler.builder.emitNullary(OpCodes.RETG);
    
    // Add function creation instruction
    this.builder.emitUnary(
      OpCodes.NEWC,
      childCompiler.builder.getFunctionIndex()
    );

    // Assign function as variable
    this.emitStoreSymbol(stmt.name);

    // Load it right back
    this.emitLoadSymbol(stmt.name);

    return { maxStackSize: Math.max(maxStackSize, 1) };
  }

  visitIfStmt(stmt: StmtNS.If): ExpressionResult {
    // Compile test
    const testResult = this.compile(stmt.condition);
    const elseLabel = this.builder.emitJump(OpCodes.BRF);

    // Compile consequent
    const conseqResult = this.compileStatements(stmt.body);
    const endLabel = this.builder.emitJump(OpCodes.BR);

    // Compile alternate
    this.builder.markLabel(elseLabel);
    const altResult = stmt.elseBlock
      ? this.compileStatements(stmt.elseBlock)
      : { maxStackSize: 0 };

    this.builder.markLabel(endLabel);

    return {
      maxStackSize: Math.max(
        testResult.maxStackSize,
        conseqResult.maxStackSize,
        altResult.maxStackSize
      ),
    };
  }

  visitWhileStmt(stmt: StmtNS.While): ExpressionResult {
    const loopLabel = this.builder.markLabel();

    // Compile test
    const testResult = this.compile(stmt.condition);
    const endLabel = this.builder.emitJump(OpCodes.BRF);

    // Compile body
    const bodyResult = this.compileStatements(stmt.body);
    this.builder.emitJump(OpCodes.BR, loopLabel);

    this.builder.markLabel(endLabel);
    this.builder.emitNullary(OpCodes.LGCU); // While loops return undefined

    return {
      maxStackSize: Math.max(
        testResult.maxStackSize,
        bodyResult.maxStackSize,
        1
      ),
    };
  }

  visitPassStmt(stmt: StmtNS.Pass): ExpressionResult {
    this.builder.emitNullary(OpCodes.LGCU);
    return { maxStackSize: 1 };
  }

  visitIndentCreation(stmt: StmtNS.Indent): ExpressionResult {
    this.builder.emitNullary(OpCodes.LGCU);
    return { maxStackSize: 1 };
  }

  visitDedentCreation(stmt: StmtNS.Dedent): ExpressionResult {
    this.builder.emitNullary(OpCodes.LGCU);
    return { maxStackSize: 1 };
  }

  visitAnnAssignStmt(stmt: StmtNS.AnnAssign): ExpressionResult {
    throw new Error("AnnAssign not yet implemented in SVML compiler");
  }

  visitBreakStmt(stmt: StmtNS.Break): ExpressionResult {
    throw new Error("Break not yet implemented in SVML compiler");
  }

  visitContinueStmt(stmt: StmtNS.Continue): ExpressionResult {
    throw new Error("Continue not yet implemented in SVML compiler");
  }

  visitFromImportStmt(stmt: StmtNS.FromImport): ExpressionResult {
    throw new Error("FromImport not yet implemented in SVML compiler");
  }

  visitGlobalStmt(stmt: StmtNS.Global): ExpressionResult {
    this.builder.emitNullary(OpCodes.LGCU);
    return { maxStackSize: 1 };
  }

  visitNonLocalStmt(stmt: StmtNS.NonLocal): ExpressionResult {
    this.builder.emitNullary(OpCodes.LGCU);
    return { maxStackSize: 1 };
  }

  visitAssertStmt(stmt: StmtNS.Assert): ExpressionResult {
    throw new Error("Assert not yet implemented in SVML compiler");
  }

  visitForStmt(stmt: StmtNS.For): ExpressionResult {
    throw new Error("For not yet implemented in SVML compiler");
  }

  visitFileInputStmt(stmt: StmtNS.FileInput): ExpressionResult {
    const { maxStackSize } = this.compileStatements(stmt.statements);
    this.builder.emitNullary(OpCodes.RETG);
    return { maxStackSize: Math.max(maxStackSize, 1) };
  }

  compileStatements(statements: StmtNS.Stmt[]): ExpressionResult {
    if (statements.length === 0) {
      this.builder.emitNullary(OpCodes.LGCU);
      return { maxStackSize: 1 };
    }

    let maxStackSize = 0;

    for (let i = 0; i < statements.length; i++) {
      const result = this.compile(statements[i]);
      maxStackSize = Math.max(maxStackSize, result.maxStackSize);

      // Assumption: every statement/expression leaves exactly one value.
      // Earlier statement results are not needed and would otherwise accumulate,
      // breaking block-level stack balance. Pop N-1 intermediates so only the last
      // statement's value remains (the block result). Any leftovers indicate a
      // compiler emission bug (e.g. extra LGCU or unconsumed operands).
      if (i < statements.length - 1) {
        this.builder.emitNullary(OpCodes.POPG);
      }
    }

    return { maxStackSize };
  }
}
