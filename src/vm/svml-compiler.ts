import { StmtNS, ExprNS } from "../ast-types";
import { Token } from "../tokenizer";
import { TokenType } from "../tokens";
import { PRIMITIVE_FUNCTIONS } from "./sinter-primitives";
import { InstructionBuilder, SVMProgram, SVMFunction } from "./types";
import OpCodes from "./opcodes";
import { FunctionEnvironments, Environment, Resolver } from "../resolver";
import { DeadCodeEliminator } from "./svml-opt";

enum SVMLType {
  PRIMITIVE = "primitive",
  INTERNAL = "internal",
  USERDECLARED = "userdeclared",
}

class SVMLSymbolResolver {
  private envNodeToIndex = new WeakMap<Environment, Map<string, number>>();
  private envNextIndex = new WeakMap<Environment, number>();

  getIndex(env: Environment, name: string): number {
    let nodeMap = this.envNodeToIndex.get(env);
    if (!nodeMap) {
      nodeMap = new Map<string, number>();
      this.envNodeToIndex.set(env, nodeMap);
      this.envNextIndex.set(env, 0);
    }
    const existing = nodeMap.get(name);
    if (existing !== undefined) return existing;

    const next = this.envNextIndex.get(env)!;
    nodeMap.set(name, next);
    this.envNextIndex.set(env, next + 1);
    return next;
  }

  getSymbol(
    env: Environment,
    node: Token
  ): {
    type: SVMLType;
    index: number;
    envLevel: number;
  } {
    const name = node.lexeme;
    const parentEnv = env.lookupNameEnv(node);

    // If the node is a primitive function, return the index
    if (parentEnv === Environment.GlobalEnvironment) {
      if (!PRIMITIVE_FUNCTIONS.has(name)) {
        throw new Error(`Primitive function ${name} not implemented`);
      }
      return {
        type: SVMLType.PRIMITIVE,
        index: PRIMITIVE_FUNCTIONS.get(name)!,
        envLevel: 0,
      };
    }

    // If the node is a user-declared variable, return the index
    if (parentEnv != null && parentEnv != Environment.GlobalEnvironment) {
      const index = this.getIndex(parentEnv, name);
      const envLevel = env.lookupName(node);
      return {
        type: SVMLType.USERDECLARED,
        index,
        envLevel,
      };
    }

    throw new Error(`Variable ${name} not found in environment`);
  }
}

export type ExpressionResult = {
  maxStackSize: number;
};

export type FunctionCompilationResult = {
  builder: InstructionBuilder;
  maxStackSize: number;
  envSize: number;
  numArgs: number;
};

/**
 * SVML Compiler implementing visitor pattern for clean AST traversal
 */
export class SVMLCompiler
  implements StmtNS.Visitor<ExpressionResult>, ExprNS.Visitor<ExpressionResult>
{
  public builder: InstructionBuilder; // Made public for access in compilation
  private currentEnvironment: Environment;
  private functionEnvironments: FunctionEnvironments;
  private isTailCall: boolean;
  private labelCounter: number = 0;

  // Function indexing for compilation
  private functionIndexMap: Map<
    StmtNS.FileInput | StmtNS.FunctionDef | ExprNS.Lambda | ExprNS.MultiLambda,
    number
  >;

  static SymbolResolver: SVMLSymbolResolver = new SVMLSymbolResolver();

  constructor(
    currentEnvironment: Environment,
    functionEnvironments: FunctionEnvironments,
    functionIndexMap?: Map<
      | StmtNS.FileInput
      | StmtNS.FunctionDef
      | ExprNS.Lambda
      | ExprNS.MultiLambda,
      number
    >
  ) {
    this.builder = new InstructionBuilder();
    this.currentEnvironment = currentEnvironment;
    this.functionEnvironments = functionEnvironments;
    this.functionIndexMap = functionIndexMap || new Map();
    this.isTailCall = false;
  }

  /**
   * Compile a statement or expression and return stack effect
   */
  compile(node: StmtNS.Stmt | ExprNS.Expr): ExpressionResult {
    return node.accept(this);
  }

  /**
   * Generate a unique label
   */
  private genLabel(prefix: string = "L"): string {
    return `${prefix}${this.labelCounter++}`;
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
    // Look up the symbol using the symbol resolver
    const { type, index, envLevel } = SVMLCompiler.SymbolResolver.getSymbol(
      this.currentEnvironment,
      expr.name
    );

    switch (type) {
      case SVMLType.PRIMITIVE:
        this.builder.emitUnary(OpCodes.NEWCP, index);
        break;
      case SVMLType.INTERNAL:
        this.builder.emitUnary(OpCodes.NEWCV, index);
        break;
      case SVMLType.USERDECLARED:
        if (envLevel === 0) {
          this.builder.emitUnary(OpCodes.LDLG, index);
        } else {
          this.builder.emitBinary(OpCodes.LDPG, index, envLevel);
        }
        break;
    }
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
    const elseLabel = this.genLabel("else");
    const endLabel = this.genLabel("end");

    // Convert to conditional expression
    if (expr.operator.type === TokenType.AND) {
      // left && right -> left ? right : false
      const testResult = this.compile(expr.left);
      this.builder.emitBranchTo(OpCodes.BRF, elseLabel);

      const conseqResult = this.compile(expr.right);
      this.builder.emitBranchTo(OpCodes.BR, endLabel);

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
      this.builder.emitBranchTo(OpCodes.BRF, elseLabel);

      this.builder.emitNullary(OpCodes.LGCB1); // true
      const conseqResult = { maxStackSize: 1 };
      this.builder.emitBranchTo(OpCodes.BR, endLabel);

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
    if (!(expr.callee instanceof ExprNS.Variable)) {
      throw new Error(
        "Unsupported call expression: callee must be an identifier"
      );
    }

    const callee: ExprNS.Variable = expr.callee;
    const { type, index, envLevel } = SVMLCompiler.SymbolResolver.getSymbol(
      this.currentEnvironment,
      callee.name
    );

    // Load function if needed
    let functionStackEffect = 0;
    if (type === SVMLType.PRIMITIVE || type === SVMLType.INTERNAL) {
      // No function loading needed for built-ins
    } else if (envLevel === 0) {
      this.builder.emitUnary(OpCodes.LDLG, index);
      functionStackEffect = 1;
    } else {
      this.builder.emitBinary(OpCodes.LDPG, index, envLevel);
      functionStackEffect = 1;
    }

    // Compile arguments last, in reverse order
    let maxArgStackSize = 0;
    for (let i = expr.args.length - 1; i >= 0; i--) {
      const argResult = this.compile(expr.args[i]);
      maxArgStackSize = Math.max(maxArgStackSize, i + argResult.maxStackSize);
    }

    // Emit call instruction
    const numArgs = expr.args.length;
    switch (type) {
      case SVMLType.PRIMITIVE:
        const primitiveOpcode = this.isTailCall
          ? OpCodes.CALLTP
          : OpCodes.CALLP;
        this.builder.emitBinary(primitiveOpcode, index, numArgs);
        break;
      case SVMLType.INTERNAL:
        const internalOpcode = this.isTailCall ? OpCodes.CALLTV : OpCodes.CALLV;
        this.builder.emitBinary(internalOpcode, index, numArgs);
        break;
      case SVMLType.USERDECLARED:
        const userOpcode = this.isTailCall ? OpCodes.CALLT : OpCodes.CALL;
        this.builder.emitUnary(userOpcode, numArgs);
        break;
    }

    return {
      maxStackSize: functionStackEffect + maxArgStackSize,
    };
  }

  visitTernaryExpr(expr: ExprNS.Ternary): ExpressionResult {
    const elseLabel = this.genLabel("else");
    const endLabel = this.genLabel("end");

    // Compile test
    const testResult = this.compile(expr.predicate);
    this.builder.emitBranchTo(OpCodes.BRF, elseLabel);

    // Compile consequent
    const conseqResult = this.compile(expr.consequent);
    this.builder.emitBranchTo(OpCodes.BR, endLabel);

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
    // Get function index for this lambda
    const functionIndex = this.functionIndexMap.get(expr);
    if (functionIndex === undefined) {
      throw new Error("Lambda function index not found");
    }

    // Emit function creation instruction
    this.builder.emitUnary(OpCodes.NEWC, functionIndex);
    return { maxStackSize: 1 };
  }

  visitMultiLambdaExpr(expr: ExprNS.MultiLambda): ExpressionResult {
    // Get function index for this multi-lambda
    const functionIndex = this.functionIndexMap.get(expr);
    if (functionIndex === undefined) {
      throw new Error("MultiLambda function index not found");
    }

    // Emit function creation instruction
    this.builder.emitUnary(OpCodes.NEWC, functionIndex);
    return { maxStackSize: 1 };
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
    const { type, index, envLevel } = SVMLCompiler.SymbolResolver.getSymbol(
      this.currentEnvironment,
      stmt.name
    );

    const initResult = this.compile(stmt.value);

    // Only user-declared variables can be assigned to
    if (type !== SVMLType.USERDECLARED) {
      throw new Error(`Cannot assign to ${type} symbol: ${stmt.name.lexeme}`);
    }

    if (envLevel === 0) {
      this.builder.emitUnary(OpCodes.STLG, index);
    } else {
      this.builder.emitBinary(OpCodes.STPG, index, envLevel);
    }

    this.builder.emitNullary(OpCodes.LGCU);
    return initResult;
  }

  visitFunctionDefStmt(stmt: StmtNS.FunctionDef): ExpressionResult {
    // Get function index for this function definition
    const functionIndex = this.functionIndexMap.get(stmt);
    if (functionIndex === undefined) {
      throw new Error("Function definition index not found");
    }

    // Emit function creation instruction
    this.builder.emitUnary(OpCodes.NEWC, functionIndex);

    // Store the function in the local variable
    const { type, index, envLevel } = SVMLCompiler.SymbolResolver.getSymbol(
      this.currentEnvironment,
      stmt.name
    );

    if (type !== SVMLType.USERDECLARED) {
      throw new Error(
        `Cannot store function to ${type} symbol: ${stmt.name.lexeme}`
      );
    }

    if (envLevel === 0) {
      this.builder.emitUnary(OpCodes.STLG, index);
    } else {
      this.builder.emitBinary(OpCodes.STPG, index, envLevel);
    }

    this.builder.emitNullary(OpCodes.LGCU);
    return { maxStackSize: 1 };
  }

  visitIfStmt(stmt: StmtNS.If): ExpressionResult {
    const elseLabel = this.genLabel("else");
    const endLabel = this.genLabel("end");

    // Compile test
    const testResult = this.compile(stmt.condition);
    this.builder.emitBranchTo(OpCodes.BRF, elseLabel);

    // Compile consequent
    const conseqResult = this.compileStatements(stmt.body);
    this.builder.emitBranchTo(OpCodes.BR, endLabel);

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
    const loopLabel = this.genLabel("loop");
    const endLabel = this.genLabel("end");

    this.builder.markLabel(loopLabel);

    // Compile test
    const testResult = this.compile(stmt.condition);
    this.builder.emitBranchTo(OpCodes.BRF, endLabel);

    // Compile body
    const bodyResult = this.compileStatements(stmt.body);
    this.builder.emitBranchTo(OpCodes.BR, loopLabel);

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
    return this.compileStatements(stmt.statements);
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

// Helper function to compile a single function
function compileSingleFunction(
  env: Environment,
  functionEnvironments: FunctionEnvironments,
  ast: StmtNS.Stmt[],
  functionIndexMap: Map<
    StmtNS.FileInput | StmtNS.FunctionDef | ExprNS.Lambda | ExprNS.MultiLambda,
    number
  >
): FunctionCompilationResult {
  const compiler = new SVMLCompiler(
    env,
    functionEnvironments,
    functionIndexMap
  );
  const result = compiler.compileStatements(ast);

  // Add return if needed (functions should always return something)
  compiler.builder.emitNullary(OpCodes.RETG);

  // Calculate environment size (number of local variables)
  const envSize = Array.from(env.names.keys()).length;

  return {
    builder: compiler.builder,
    maxStackSize: result.maxStackSize,
    envSize,
    numArgs: 0, // Will be set by caller
  };
}

export function compileAll(program: StmtNS.FileInput): SVMProgram {
  // Step 1: Resolve environments
  const resolver = new Resolver("", program);
  const functionEnvironments = resolver.resolveEnvironments(program);

  // Step 2: Create function index map
  const functionIndexMap = new Map<
    StmtNS.FileInput | StmtNS.FunctionDef | ExprNS.Lambda | ExprNS.MultiLambda,
    number
  >();
  let functionCounter = 0;

  for (const [node] of functionEnvironments) {
    functionIndexMap.set(node, functionCounter);
    functionCounter++;
  }

  // Step 3: Collect and compile all functions
  const svmFunctions: SVMFunction[] = [];

  // Compile user-defined functions first
  let entryPointIndex: number = 0;
  for (const [node, env] of functionEnvironments) {
    let ast: StmtNS.Stmt[];
    let numArgs: number;

    if (node instanceof StmtNS.FunctionDef) {
      ast = node.body;
      numArgs = node.parameters.length;
    } else if (node instanceof ExprNS.Lambda) {
      ast = [new StmtNS.Return(node.startToken, node.endToken, node.body)];
      numArgs = node.parameters.length;
    } else if (node instanceof ExprNS.MultiLambda) {
      ast = node.body;
      numArgs = node.parameters.length;
    } else if (node instanceof StmtNS.FileInput) {
      ast = node.statements;
      entryPointIndex = svmFunctions.length;
      numArgs = 0;
    } else {
      throw new Error("Unknown function node type");
    }

    console.log(env);

    // Compile the function
    const { builder, maxStackSize, envSize } = compileSingleFunction(
      env,
      functionEnvironments,
      ast,
      functionIndexMap
    );

    // Optimize and create SVM function
    builder.optimize(new DeadCodeEliminator());
    const svmFunction = builder.toSVMFunction(maxStackSize, envSize, numArgs);
    svmFunctions.push(svmFunction);
  }

  return [entryPointIndex, svmFunctions];
}
