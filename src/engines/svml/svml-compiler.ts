import { ExprNS, StmtNS } from "../../ast-types";
import { Environment, FunctionEnvironments, Resolver } from "../../resolver";
import type { OptimizationHint } from "../../specialization";
import type { HintStore } from "../../specialization/framework/hint";
import type { FunctionUnit } from "../../specialization/framework/function-unit";
import { ScopeIndexMap } from "../../specialization/framework/scope-index-map";
import { BOOL_BIT, FLOAT_BIT, INT_BIT } from "../../specialization/type-analysis/lattice";
import { Token } from "../../tokenizer";
import { TokenType } from "../../tokens";
import { SVMLIRBuilder } from "./SVMLIRBuilder";
import { PRIMITIVE_FUNCTIONS } from "./builtins";
import OpCodes from "./opcodes";
import { SVMLProgram } from "./types";


/** Signed 32-bit integer bounds used to decide LGCI vs LGCF64 encoding. */
const I32_MIN = -2_147_483_648;
const I32_MAX = 2_147_483_647;

interface CompilerAnnotation {
  slot: number;
  envLevel: number;
  isPrimitive: boolean;
  primitiveIndex?: number;
}

export type ExpressionResult = {
  maxStackSize: number;
};

export class SVMLCompiler
  implements StmtNS.Visitor<ExpressionResult>, ExprNS.Visitor<ExpressionResult>
{
  private builder: SVMLIRBuilder;
  private currentEnvironment: Environment;
  private functionEnvironments: FunctionEnvironments;
  private isTailCall: boolean;
  private hints: HintStore | undefined;
  private unitMap?: ReadonlyMap<StmtNS.FileInput | StmtNS.FunctionDef, FunctionUnit>;
  private _scopeIndexMap?: ScopeIndexMap;

  private tokenAnnotations = new WeakMap<Token, CompilerAnnotation>();
  private envSlotCounters = new WeakMap<Environment, number>();
  private envSlotMaps = new WeakMap<Environment, Map<string, number>>();
  private tmpCounter = 0;

  private loopStack: Array<{
    breakLabel: number;
    continueLabel: number;
    iteratorOnStack: boolean;
  }> = [];

  constructor(
    currentEnvironment: Environment,
    functionEnvironments: FunctionEnvironments,
    builder: SVMLIRBuilder,
    hints?: HintStore,
  ) {
    this.builder = builder;
    this.currentEnvironment = currentEnvironment;
    this.functionEnvironments = functionEnvironments;
    this.isTailCall = false;
    this.hints = hints;
  }

  setHints(hints: HintStore): void {
    this.hints = hints;
  }

  /** Scope → function index map, populated during compilation via fromProgramUnit(). */
  get scopeIndexMap(): ScopeIndexMap | undefined {
    return this._scopeIndexMap;
  }

  private getHint(node: ExprNS.Expr | StmtNS.Stmt): OptimizationHint | undefined {
    return this.hints?.get(node);
  }

  /**
   * Create SVMLCompiler from program AST.
   * Pass pre-computed environments (from analyzeWithEnvironments) to avoid a second resolver run.
   */
  static fromProgram(
    program: StmtNS.FileInput,
    functionEnvironments?: FunctionEnvironments,
  ): SVMLCompiler {
    if (!functionEnvironments) {
      const resolver = new Resolver("", program);
      functionEnvironments = resolver.resolveEnvironments(program);
    }
    const mainEnv = functionEnvironments.get(program);
    if (!mainEnv) {
      throw new Error("Main program environment not found");
    }
    SVMLIRBuilder.resetIndex();
    const builder = new SVMLIRBuilder(0);
    return new SVMLCompiler(mainEnv, functionEnvironments, builder);
  }

  /**
   * Create SVMLCompiler wired to a unit map from optimize().
   * Each child compiler automatically gets the correct per-function hints.
   */
  static fromProgramUnit(
    program: StmtNS.FileInput,
    functionEnvironments: FunctionEnvironments,
    unitMap: ReadonlyMap<StmtNS.FileInput | StmtNS.FunctionDef, FunctionUnit>,
  ): SVMLCompiler {
    const mainEnv = functionEnvironments.get(program);
    if (!mainEnv) {
      throw new Error("Main program environment not found");
    }
    SVMLIRBuilder.resetIndex();
    const builder = new SVMLIRBuilder(0);
    const rootHints = unitMap.get(program)?.hints;
    const compiler = new SVMLCompiler(mainEnv, functionEnvironments, builder, rootHints);
    compiler.unitMap = unitMap;
    compiler._scopeIndexMap = new ScopeIndexMap();
    compiler._scopeIndexMap.register(program, builder.getFunctionIndex());
    return compiler;
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

    // Per-unit hints: if a FunctionUnit exists for this scope, use its HintStore
    const childUnit = this.unitMap?.get(node as StmtNS.FunctionDef);
    const childHints = childUnit?.hints ?? this.hints;

    const compiler = new SVMLCompiler(nextEnvironment, this.functionEnvironments, builder, childHints);
    compiler.unitMap = this.unitMap;
    compiler._scopeIndexMap = this._scopeIndexMap;
    if (this._scopeIndexMap && node instanceof StmtNS.FunctionDef) {
      this._scopeIndexMap.register(node, builder.getFunctionIndex());
    }
    const slotMap = new Map<string, number>();
    compiler.envSlotMaps.set(nextEnvironment, slotMap);

    for (let i = 0; i < node.parameters.length; i++) {
      const paramName = node.parameters[i].lexeme;
      slotMap.set(paramName, i);
    }

    compiler.envSlotCounters.set(nextEnvironment, numArgs);

    return compiler;
  }

  /**
   * Compile entire program and return an immutable SVMLProgram.
   */
  compileProgram(program: StmtNS.FileInput): SVMLProgram {
    this.compile(program);

    const allBuilders = this.builder.getAllBuilders(true);
    const functions = allBuilders.map(b => b.build());

    return new SVMLProgram(0, functions);
  }

  compile(node: StmtNS.Stmt | ExprNS.Expr): ExpressionResult {
    return node.accept(this);
  }

  private getTokenAnnotation(token: Token): CompilerAnnotation {
    let annotation = this.tokenAnnotations.get(token);
    if (annotation) {
      return annotation;
    }

    const name = token.lexeme;
    const parentEnv = this.currentEnvironment.lookupNameEnv(token);

    if (parentEnv !== null && parentEnv.enclosing === null) {
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
      this.builder.emitBinary(OpCodes.LDPG, annotation.slot, annotation.envLevel);
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
      this.builder.emitBinary(OpCodes.STPG, annotation.slot, annotation.envLevel);
    }
  }

  private emitFunctionCall(token: Token, numArgs: number): void {
    const annotation = this.getTokenAnnotation(token);

    if (annotation.isPrimitive) {
      const primitiveOpcode = this.isTailCall ? OpCodes.CALLTP : OpCodes.CALLP;
      this.builder.emitPrimitiveCall(primitiveOpcode, annotation.primitiveIndex!, numArgs);
    } else {
      const userOpcode = this.isTailCall ? OpCodes.CALLT : OpCodes.CALL;
      this.builder.emitCall(userOpcode, numArgs);
    }
  }

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
          if (Number.isInteger(value) && I32_MIN <= value && value <= I32_MAX) {
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

  visitStarredExpr(_expr: ExprNS.Starred): ExpressionResult {
    throw new Error("Starred expressions not yet supported in SVML compiler");
  }

  visitBigIntLiteralExpr(expr: ExprNS.BigIntLiteral): ExpressionResult {
    const numValue = Number(expr.value);
    if (Number.isInteger(numValue) && I32_MIN <= numValue && numValue <= I32_MAX) {
      this.builder.emitUnary(OpCodes.LGCI, numValue);
    } else {
      this.builder.emitUnary(OpCodes.LGCF64, numValue);
    }

    return { maxStackSize: 1 };
  }

  visitComplexExpr(_expr: ExprNS.Complex): ExpressionResult {
    // TODO: needs proper SVML support for complex numbers
    throw new Error("Complex numbers not yet supported in SVML compiler");
  }

  visitListExpr(expr: ExprNS.List): ExpressionResult {
    const n = expr.elements.length;
    // Spill to a named slot because SVML has no direct stack-to-array-store
    const tmpSlot = this.getOrAssignSlot(
      this.currentEnvironment,
      `__list_tmp_${this.tmpCounter++}`,
    );

    this.builder.emitUnary(OpCodes.LGCI, n);
    this.builder.emitNullary(OpCodes.NEWA);
    this.builder.emitUnary(OpCodes.STLG, tmpSlot);

    for (let i = 0; i < n; i++) {
      this.builder.emitUnary(OpCodes.LDLG, tmpSlot);
      this.builder.emitUnary(OpCodes.LGCI, i);
      this.compile(expr.elements[i]);
      this.builder.emitNullary(OpCodes.STAG);
    }

    this.builder.emitUnary(OpCodes.LDLG, tmpSlot);

    return { maxStackSize: 3 + 1 };
  }

  visitSubscriptExpr(expr: ExprNS.Subscript): ExpressionResult {
    this.compile(expr.value);
    this.compile(expr.index);
    this.builder.emitNullary(OpCodes.LDAG);
    return { maxStackSize: 2 };
  }

  visitVariableExpr(expr: ExprNS.Variable): ExpressionResult {
    this.emitLoadSymbol(expr.name);
    return { maxStackSize: 1 };
  }

  // [generic, specialized] opcode pairs, indexed by token type
  private static readonly BINARY_OPCODES = new Map<TokenType, [number, number]>([
    [TokenType.PLUS, [OpCodes.ADDG, OpCodes.ADDF]],
    [TokenType.MINUS, [OpCodes.SUBG, OpCodes.SUBF]],
    [TokenType.STAR, [OpCodes.MULG, OpCodes.MULF]],
    [TokenType.SLASH, [OpCodes.DIVG, OpCodes.DIVF]],
    [TokenType.PERCENT, [OpCodes.MODG, OpCodes.MODF]],
    [TokenType.DOUBLESLASH, [OpCodes.FLOORDIVG, OpCodes.FLOORDIVF]],
  ]);

  private static readonly COMPARE_OPCODES = new Map<TokenType, [number, number]>([
    [TokenType.LESS, [OpCodes.LTG, OpCodes.LTF]],
    [TokenType.GREATER, [OpCodes.GTG, OpCodes.GTF]],
    [TokenType.LESSEQUAL, [OpCodes.LEG, OpCodes.LEF]],
    [TokenType.GREATEREQUAL, [OpCodes.GEG, OpCodes.GEF]],
    [TokenType.DOUBLEEQUAL, [OpCodes.EQG, OpCodes.EQF]],
    [TokenType.NOTEQUAL, [OpCodes.NEQG, OpCodes.NEQF]],
  ]);

  private getBinaryOpCode(operator: Token, specialized = false): number {
    const pair = SVMLCompiler.BINARY_OPCODES.get(operator.type);
    if (!pair) throw new Error(`Unsupported binary operator: ${operator.lexeme}`);
    return pair[specialized ? 1 : 0];
  }

  private getCompareOpCode(operator: Token, specialized = false): number {
    const pair = SVMLCompiler.COMPARE_OPCODES.get(operator.type);
    if (!pair) throw new Error(`Unsupported comparison operator: ${operator.lexeme}`);
    return pair[specialized ? 1 : 0];
  }

  /** True when both operands have a statically known numeric type (int or float). */
  private bothNumeric(left: ExprNS.Expr, right: ExprNS.Expr): boolean {
    const lk = this.getHint(left)?.type?.kinds;
    const rk = this.getHint(right)?.type?.kinds;
    return (lk === INT_BIT || lk === FLOAT_BIT) && (rk === INT_BIT || rk === FLOAT_BIT);
  }

  visitBinaryExpr(expr: ExprNS.Binary): ExpressionResult {
    const opcode = this.getBinaryOpCode(expr.operator, this.bothNumeric(expr.left, expr.right));
    const leftResult = this.compile(expr.left);
    const rightResult = this.compile(expr.right);
    this.builder.emitNullary(opcode);
    return { maxStackSize: Math.max(leftResult.maxStackSize, 1 + rightResult.maxStackSize) };
  }

  visitCompareExpr(expr: ExprNS.Compare): ExpressionResult {
    const opcode = this.getCompareOpCode(expr.operator, this.bothNumeric(expr.left, expr.right));
    const leftResult = this.compile(expr.left);
    const rightResult = this.compile(expr.right);
    this.builder.emitNullary(opcode);
    return { maxStackSize: Math.max(leftResult.maxStackSize, 1 + rightResult.maxStackSize) };
  }

  visitBoolOpExpr(expr: ExprNS.BoolOp): ExpressionResult {
    // Python and/or return the short-circuit operand, not a boolean literal.
    // Save left to a temp slot so it can be returned when it is the result.
    // BRF/BRT use Python truthiness (see SVMLInterpreter.isTruthy).
    const tmpSlot = this.getOrAssignSlot(
      this.currentEnvironment,
      `__boolop_tmp_${this.tmpCounter++}`,
    );

    if (expr.operator.type === TokenType.AND) {
      // x and y → x if not truthy(x) else y
      const leftResult = this.compile(expr.left);
      this.builder.emitUnary(OpCodes.STLG, tmpSlot); // save x
      this.builder.emitUnary(OpCodes.LDLG, tmpSlot); // reload for branch
      const elseLabel = this.builder.emitJump(OpCodes.BRF); // if falsy, return x

      const conseqResult = this.compile(expr.right);
      const endLabel = this.builder.emitJump(OpCodes.BR);

      this.builder.markLabel(elseLabel);
      this.builder.emitUnary(OpCodes.LDLG, tmpSlot);

      this.builder.markLabel(endLabel);

      return {
        maxStackSize: Math.max(leftResult.maxStackSize, conseqResult.maxStackSize, 1),
      };
    } else if (expr.operator.type === TokenType.OR) {
      // x or y → x if truthy(x) else y
      const leftResult = this.compile(expr.left);
      this.builder.emitUnary(OpCodes.STLG, tmpSlot); // save x
      this.builder.emitUnary(OpCodes.LDLG, tmpSlot); // reload for branch
      const elseLabel = this.builder.emitJump(OpCodes.BRT); // if truthy, return x

      const altResult = this.compile(expr.right);
      const endLabel = this.builder.emitJump(OpCodes.BR);

      this.builder.markLabel(elseLabel);
      this.builder.emitUnary(OpCodes.LDLG, tmpSlot); // return x (the truthy value)

      this.builder.markLabel(endLabel);

      return {
        maxStackSize: Math.max(leftResult.maxStackSize, altResult.maxStackSize, 1),
      };
    }
    throw new Error(`Unsupported boolean operator: ${expr.operator.lexeme}`);
  }

  visitUnaryExpr(expr: ExprNS.Unary): ExpressionResult {
    let opcode: number;

    switch (expr.operator.type) {
      case TokenType.NOT: {
        opcode = this.getHint(expr.right)?.type?.kinds === BOOL_BIT ? OpCodes.NOTB : OpCodes.NOTG;
        break;
      }
      case TokenType.MINUS: {
        const k = this.getHint(expr.right)?.type?.kinds;
        opcode = k === INT_BIT || k === FLOAT_BIT ? OpCodes.NEGF : OpCodes.NEGG;
        break;
      }
      case TokenType.PLUS:
        return this.compile(expr.right);
      default:
        throw new Error(`Unsupported unary operator: ${expr.operator.lexeme}`);
    }

    const operandResult = this.compile(expr.right);
    this.builder.emitNullary(opcode);

    return { maxStackSize: operandResult.maxStackSize };
  }

  visitCallExpr(expr: ExprNS.Call): ExpressionResult {
    if (!(expr.callee instanceof ExprNS.Variable)) {
      throw new Error("Unsupported call expression: callee must be an identifier");
    }

    const callee: ExprNS.Variable = expr.callee;

    const { maxStackSize: functionStackEffect } = this.emitLoadSymbol(callee.name);

    let maxArgStackSize = 0;
    for (let i = 0; i < expr.args.length; i++) {
      const argResult = this.compile(expr.args[i]);
      maxArgStackSize = Math.max(maxArgStackSize, i + argResult.maxStackSize);
    }

    const numArgs = expr.args.length;
    this.emitFunctionCall(callee.name, numArgs);

    return {
      maxStackSize: functionStackEffect + maxArgStackSize,
    };
  }

  visitTernaryExpr(expr: ExprNS.Ternary): ExpressionResult {
    const testResult = this.compile(expr.predicate);
    const elseLabel = this.builder.emitJump(OpCodes.BRF);

    const conseqResult = this.compile(expr.consequent);
    const endLabel = this.builder.emitJump(OpCodes.BR);

    this.builder.markLabel(elseLabel);
    const altResult = this.compile(expr.alternative);

    this.builder.markLabel(endLabel);

    return {
      maxStackSize: Math.max(
        testResult.maxStackSize,
        conseqResult.maxStackSize,
        altResult.maxStackSize,
      ),
    };
  }

  visitNoneExpr(_expr: ExprNS.None): ExpressionResult {
    this.builder.emitNullary(OpCodes.LGCN);
    return { maxStackSize: 1 };
  }

  /** Compile a closure body, emit RETG, and emit NEWC in the parent scope. */
  private compileClosure(
    node: StmtNS.FunctionDef | ExprNS.Lambda | ExprNS.MultiLambda,
    compileBody: (compiler: SVMLCompiler) => ExpressionResult,
  ): ExpressionResult {
    const compiler = this.fromFunctionNode(node);
    const { maxStackSize } = compileBody(compiler);
    // Functions must always return a value
    compiler.builder.emitNullary(OpCodes.RETG);
    this.builder.emitUnary(OpCodes.NEWC, compiler.builder.getFunctionIndex());
    return { maxStackSize: Math.max(maxStackSize, 1) };
  }

  visitLambdaExpr(expr: ExprNS.Lambda): ExpressionResult {
    const ast = new StmtNS.Return(expr.startToken, expr.endToken, expr.body);
    return this.compileClosure(expr, c => c.compile(ast));
  }

  visitMultiLambdaExpr(expr: ExprNS.MultiLambda): ExpressionResult {
    return this.compileClosure(expr, c => c.compileStatements(expr.body));
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

    this.emitStoreSymbol((stmt.target as ExprNS.Variable).name);

    this.builder.emitNullary(OpCodes.LGCU);
    return initResult;
  }

  visitFunctionDefStmt(stmt: StmtNS.FunctionDef): ExpressionResult {
    const result = this.compileClosure(stmt, c => c.compileStatements(stmt.body));
    this.emitStoreSymbol(stmt.name);
    this.builder.emitNullary(OpCodes.LGCU);
    return result;
  }

  visitIfStmt(stmt: StmtNS.If): ExpressionResult {
    const testResult = this.compile(stmt.condition);
    const elseLabel = this.builder.emitJump(OpCodes.BRF);

    const conseqResult = this.compileStatements(stmt.body);
    const endLabel = this.builder.emitJump(OpCodes.BR);

    this.builder.markLabel(elseLabel);
    const altResult = stmt.elseBlock
      ? this.compileStatements(stmt.elseBlock)
      : (() => {
          this.builder.emitNullary(OpCodes.LGCU);
          return { maxStackSize: 1 };
        })();

    this.builder.markLabel(endLabel);

    return {
      maxStackSize: Math.max(
        testResult.maxStackSize,
        conseqResult.maxStackSize,
        altResult.maxStackSize,
      ),
    };
  }

  visitWhileStmt(stmt: StmtNS.While): ExpressionResult {
    const loopLabel = this.builder.markLabel();
    const endLabel = this.builder.getNextLabel();

    this.loopStack.push({
      breakLabel: endLabel,
      continueLabel: loopLabel,
      iteratorOnStack: false,
    });

    const testResult = this.compile(stmt.condition);
    this.builder.emitJump(OpCodes.BRF, endLabel);

    const bodyResult = this.compileStatements(stmt.body);
    // Body values aren't used; discard to maintain stack balance
    this.builder.emitNullary(OpCodes.POPG);
    this.builder.emitJump(OpCodes.BR, loopLabel);

    this.loopStack.pop();

    this.builder.markLabel(endLabel);
    this.builder.emitNullary(OpCodes.LGCU);

    return {
      maxStackSize: Math.max(testResult.maxStackSize, bodyResult.maxStackSize, 1),
    };
  }

  visitPassStmt(_stmt: StmtNS.Pass): ExpressionResult {
    this.builder.emitNullary(OpCodes.LGCU);
    return { maxStackSize: 1 };
  }

  visitAnnAssignStmt(_stmt: StmtNS.AnnAssign): ExpressionResult {
    throw new Error("AnnAssign not yet implemented in SVML compiler");
  }

  visitBreakStmt(_stmt: StmtNS.Break): ExpressionResult {
    if (this.loopStack.length === 0) {
      throw new Error("Break statement outside loop");
    }
    const { breakLabel, iteratorOnStack } = this.loopStack[this.loopStack.length - 1];
    if (iteratorOnStack) {
      this.builder.emitNullary(OpCodes.POPG); // drop iterator
    }
    this.builder.emitJump(OpCodes.BR, breakLabel);
    return { maxStackSize: 0 };
  }

  visitContinueStmt(_stmt: StmtNS.Continue): ExpressionResult {
    if (this.loopStack.length === 0) {
      throw new Error("Continue statement outside loop");
    }
    const { continueLabel } = this.loopStack[this.loopStack.length - 1];
    this.builder.emitJump(OpCodes.BR, continueLabel);
    return { maxStackSize: 0 };
  }

  visitFromImportStmt(_stmt: StmtNS.FromImport): ExpressionResult {
    throw new Error("FromImport not yet implemented in SVML compiler");
  }

  visitGlobalStmt(_stmt: StmtNS.Global): ExpressionResult {
    this.builder.emitNullary(OpCodes.LGCU);
    return { maxStackSize: 1 };
  }

  visitNonLocalStmt(_stmt: StmtNS.NonLocal): ExpressionResult {
    this.builder.emitNullary(OpCodes.LGCU);
    return { maxStackSize: 1 };
  }

  visitAssertStmt(_stmt: StmtNS.Assert): ExpressionResult {
    throw new Error("Assert not yet implemented in SVML compiler");
  }

  visitForStmt(stmt: StmtNS.For): ExpressionResult {
    this.compile(stmt.iter);
    this.builder.emitNullary(OpCodes.NEWITER);

    const loopStartLabel = this.builder.markLabel();
    const loopEndLabel = this.builder.getNextLabel();

    this.loopStack.push({
      breakLabel: loopEndLabel,
      continueLabel: loopStartLabel,
      iteratorOnStack: true,
    });

    // FOR_ITER: if exhausted, pops iter and jumps to loopEnd; else pushes next value
    this.builder.emitJump(OpCodes.FOR_ITER, loopEndLabel);

    // Iterator stays on stack below the value
    const targetSlot = this.getOrAssignSlot(this.currentEnvironment, stmt.target.lexeme);
    this.builder.emitUnary(OpCodes.STLG, targetSlot);

    const bodyResult = this.compileStatements(stmt.body);
    // Body values aren't used; discard to maintain stack balance
    this.builder.emitNullary(OpCodes.POPG);

    this.builder.emitJump(OpCodes.BR, loopStartLabel);

    this.loopStack.pop();

    // Iterator already popped by FOR_ITER on exhaustion
    this.builder.markLabel(loopEndLabel);
    this.builder.emitNullary(OpCodes.LGCU);

    return { maxStackSize: Math.max(bodyResult.maxStackSize + 2, 2) };
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
