import { ExprNS, StmtNS } from "../../ast-types";
import { Environment, FunctionEnvironments, Resolver } from "../../resolver";
import type { ConstLattice } from "../../specialization/analysis/const/lattice";
import type { TypeLattice } from "../../specialization/analysis/type/lattice";
import type { Function } from "../../specialization/program/units/function/function";
import {
  BOOL_BIT,
  FLOAT_BIT,
} from "../../specialization/analysis/type/lattice";

/** Static (ROOT-context) DFA reads the SVML compiler needs. Speculative
 *  reads are not exposed: the compiler only consults static facts; per-call
 *  speculative bodies arrive pre-pruned via `compileFunction(unit, body)`. */
interface DfaQuery {
  typeOf(nodeId: number): TypeLattice | undefined;
  constOf(nodeId: number): ConstLattice | undefined;
}
import math from "../../stdlib/math";
import memo from "../../stdlib/memo";
import misc from "../../stdlib/misc";
import { Token, TokenType } from "../../tokenizer";
import { SVMLIRBuilder } from "./SVMLIRBuilder";
import { PRIMITIVE_FUNCTIONS } from "./builtins";
import OpCodes from "./opcodes";
import { SVMLIR, SVMLProgram } from "./types";
import { SvmlSlotTable } from "./function-slots";

/** Signed 32-bit integer bounds used to decide LGCI vs LGCF64 encoding. */
const I32_MIN = -2_147_483_648;
const I32_MAX = 2_147_483_647;

/**
 * A hint is "concrete" when the static analysis already pinned both the type
 * kind (exactly one bit set) and a known constant value — runtime observation
 * cannot refine it further. Used to elide observation-site recording on
 * trivially monomorphic stores.
 */
function isConcrete(type: TypeLattice | undefined, constVal: ConstLattice | undefined): boolean {
  if (!type || !constVal) return false;
  // Singleton kind: exactly one bit set.
  const kinds = type.kinds;
  if (kinds === 0 || (kinds & (kinds - 1)) !== 0) return false;
  return constVal.tag === "const";
}

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
  private dfaQuery: DfaQuery | undefined;
  /**
   * SVML-local dense function-table slot assignment. Seeded at top-level
   * construction by a pre-order AST walk over FunctionDef/Lambda/MultiLambda,
   * and inherited by child compilers through `fromFunctionNode`. Transforms
   * that mint new functions during JIT get a fresh slot on first query.
   */
  private slots!: SvmlSlotTable;

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
    dfaQuery?: DfaQuery,
  ) {
    this.builder = builder;
    this.currentEnvironment = currentEnvironment;
    this.functionEnvironments = functionEnvironments;
    this.isTailCall = false;
    this.dfaQuery = dfaQuery;
  }

  private getType(node: ExprNS.Expr | StmtNS.Stmt): TypeLattice | undefined {
    return this.dfaQuery?.typeOf(node.id);
  }

  private getConst(node: ExprNS.Expr | StmtNS.Stmt): ConstLattice | undefined {
    return this.dfaQuery?.constOf(node.id);
  }

  /** Pure-FLOAT mask used to decide F-opcode specialization. F-variants read
   *  operands as JS `number`; INT values at runtime are JS `bigint`, which
   *  would crash. This predicate gates specialization on provably-float
   *  operands only — int-numeric goes through the G-path which dispatches
   *  on typeof. (Pre-refactor this mask included INT_BIT because int and
   *  float both lived in JS number; that collapse is what the refactor
   *  removed.) */
  private static readonly FLOAT_KIND_MASK = FLOAT_BIT;

  private isStaticallyNumeric(node: ExprNS.Expr): boolean {
    const k = this.getType(node)?.kinds;
    return k !== undefined && k !== 0 && (k & ~SVMLCompiler.FLOAT_KIND_MASK) === 0;
  }

  /** Per-operand specialization decision. `"static"` = proven numeric by
   *  static analysis (emits F-opcode, no guard); `"none"` = generic opcode.
   *  V2 drops the "entry-guarded" path: under live-chain dispatch there's
   *  no deopt mechanism, and F-variants read bigint values as float (crash),
   *  so speculative numeric narrowing needs a guard or it's unsound.
   *  Static-only keeps F-specialization where the type is proven at ROOT. */
  private numericMode(node: ExprNS.Expr): "static" | "none" {
    return this.isStaticallyNumeric(node) ? "static" : "none";
  }

  /** Slot key → expected const value, populated when visitAssignStmt emits
   *  a peek-guard verifying the RHS's speculative const. Reads of a slot
   *  tracked here are GUARANTEED to hold the recorded value at runtime,
   *  so any expression whose speculative const flows from these slots is
   *  const-pinned and can skip runtime evaluation entirely. This is the
   *  anchor that lets visitIfStmt drop the cond eval and dead arm. */
  private constGuardedSlots = new Map<string, number>();

  /**
   * Create SVMLCompiler from program AST.
   * Analysis pre-computed environments (from analyzeWithEnvironments) to avoid a second resolver run.
   */
  static fromProgram(
    program: StmtNS.FileInput,
    functionEnvironments?: FunctionEnvironments,
  ): SVMLCompiler {
    if (!functionEnvironments) {
      const resolver = new Resolver("", program, [], [misc, math, memo]);
      functionEnvironments = resolver.resolveEnvironments(program);
    }
    const mainEnv = functionEnvironments.get(program);
    if (!mainEnv) {
      throw new Error("Main program environment not found");
    }
    const slots = new SvmlSlotTable(program);
    const builder = new SVMLIRBuilder(0, slots.slotOfNode(program));
    builder.setScopeKey(program);
    const compiler = new SVMLCompiler(mainEnv, functionEnvironments, builder);
    compiler.slots = slots;
    return compiler;
  }

  static fromProgramUnit(
    program: StmtNS.FileInput,
    functionEnvironments: FunctionEnvironments,
    dfaQuery?: DfaQuery,
  ): SVMLCompiler {
    const mainEnv = functionEnvironments.get(program);
    if (!mainEnv) {
      throw new Error("Main program environment not found");
    }
    const slots = new SvmlSlotTable(program);
    const builder = new SVMLIRBuilder(0, slots.slotOfNode(program));
    builder.setScopeKey(program);
    const compiler = new SVMLCompiler(mainEnv, functionEnvironments, builder, dfaQuery);
    compiler.slots = slots;
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
    const childIndex = this.slots.slotOfNode(node);
    const builder = this.builder.createChildBuilder(numArgs, childIndex);
    // Only FunctionDef bodies are ScopeKeys; Lambda/MultiLambda are not DFA functions.
    if (node instanceof StmtNS.FunctionDef) {
      builder.setScopeKey(node);
    }

    const compiler = new SVMLCompiler(
      nextEnvironment,
      this.functionEnvironments,
      builder,
      this.dfaQuery,
    );
    compiler.slots = this.slots;
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

  /**
   * Lookup the stable function index for a scope. Safe to call after
   * construction (indices are pre-assigned); does not depend on compilation
   * having run.
   */
  indexOf(scope: StmtNS.FileInput | StmtNS.FunctionDef): number | undefined {
    return this.slots.slotOf(scope.id);
  }

  /**
   * Recompile a single `Function`'s body into fresh SVMLIR, without
   * touching any sibling builder. The returned IR's function index matches
   * what `compileProgram` would have assigned, so every `NEWC <index>`
   * operand in unaffected siblings remains valid.
   *
   * Only `FunctionDef` bodies are supported (matches `Function.funcAst`
   * excluding `FileInput`, which is the entry-point program and is rebuilt
   * via `compileProgram`). Lambdas are never `Function` keys.
   */
  private emitLiteralGuardValue(value: unknown): boolean {
    if (value === null) {
      this.builder.emitNullary(OpCodes.LGCN);
      return true;
    }
    switch (typeof value) {
      case "boolean":
        this.builder.emitNullary(value ? OpCodes.LGCB1 : OpCodes.LGCB0);
        return true;
      case "bigint":
        if (value >= BigInt(I32_MIN) && value <= BigInt(I32_MAX)) {
          this.builder.emitUnary(OpCodes.LGCI, Number(value));
          return true;
        }
        // Fall back to float encoding — matches visitBigIntLiteralExpr's
        // known-lossy path. Guards on out-of-i32 int constants are rare.
        this.builder.emitUnary(OpCodes.LGCF64, Number(value));
        return true;
      case "number":
        // Python float constant — always LGCF64.
        this.builder.emitUnary(OpCodes.LGCF64, value);
        return true;
      case "string":
        this.builder.emitUnary(OpCodes.LGCS, value);
        return true;
      default:
        return false;
    }
  }

  /** Compile a single FunctionDef unit.
   *  `specializedBody` — when provided, compiled in place of `funcAst.body`.
   *  The caller is responsible for ensuring the body is a valid speculative
   *  clone (NodeId-shadow policy, no topology insertion). */
  compileFunction(
    unit: Function,
    specializedBody?: ReadonlyArray<StmtNS.Stmt>,
  ): SVMLIR {
    const funcAst = unit.funcAst;
    if (!(funcAst instanceof StmtNS.FunctionDef)) {
      throw new Error(
        "compileFunction only supports FunctionDef functions; use compileProgram for FileInput",
      );
    }
    const nextEnvironment = this.functionEnvironments.get(funcAst);
    if (!nextEnvironment) {
      throw new Error("Function environment not found");
    }
    for (const param of funcAst.parameters) {
      nextEnvironment.lookupNameCurrentEnvWithError(param);
    }
    const index = this.slots.slotOfNode(funcAst);

    // Fresh standalone builder — NOT attached as a child of `this.builder`.
    // That keeps compileProgram idempotent and leaves sibling builders
    // untouched so their IR stays byte-identical.
    const numArgs = funcAst.parameters.length;
    const builder = new SVMLIRBuilder(numArgs, index);
    builder.setScopeKey(funcAst);

    const subCompiler = new SVMLCompiler(
      nextEnvironment,
      this.functionEnvironments,
      builder,
      this.dfaQuery,
    );
    subCompiler.slots = this.slots;

    const slotMap = new Map<string, number>();
    subCompiler.envSlotMaps.set(nextEnvironment, slotMap);
    for (let i = 0; i < funcAst.parameters.length; i++) {
      slotMap.set(funcAst.parameters[i].lexeme, i);
    }
    subCompiler.envSlotCounters.set(nextEnvironment, numArgs);

    subCompiler.compileStatements((specializedBody ?? funcAst.body) as StmtNS.Stmt[]);
    builder.emitNullary(OpCodes.RETG);

    return builder.build();
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
      // Record a call observation site at the CALL/CALLT pc. Primitives have
      // no scopeKey and are skipped. Call sites are always recorded: the
      // callee identity comes from the closure on the stack, not a hint on
      // the call expression, so a static hint can't pre-refine it.
      this.builder.recordCallSite();
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
          // Python float literal — always emit LGCF64 regardless of whether
          // the value is integer-valued (1.0 is a float, not an int).
          this.builder.emitUnary(OpCodes.LGCF64, value);
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
    // Python int literal. Parse as bigint so i32-overflow is detected from
    // the source value rather than from its lossy Number() cast.
    const big = BigInt(expr.value);
    if (big >= BigInt(I32_MIN) && big <= BigInt(I32_MAX)) {
      this.builder.emitUnary(OpCodes.LGCI, Number(big));
    } else {
      // TODO: add a bigints pool + LGCBI opcode for out-of-i32 ints. For now
      // fall back to float encoding, which loses precision above 2^53 and
      // collapses int-ness at runtime (same as pre-refactor behavior).
      this.builder.emitUnary(OpCodes.LGCF64, Number(big));
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

  visitBinaryExpr(expr: ExprNS.Binary): ExpressionResult {
    const lMode = this.numericMode(expr.left);
    const rMode = this.numericMode(expr.right);
    const useSpecialized = lMode !== "none" && rMode !== "none";
    const opcode = this.getBinaryOpCode(expr.operator, useSpecialized);
    const leftResult = this.compile(expr.left);
    const rightResult = this.compile(expr.right);
    this.builder.emitNullary(opcode);
    return { maxStackSize: Math.max(leftResult.maxStackSize, 1 + rightResult.maxStackSize) };
  }

  visitCompareExpr(expr: ExprNS.Compare): ExpressionResult {
    const lMode = this.numericMode(expr.left);
    const rMode = this.numericMode(expr.right);
    const useSpecialized = lMode !== "none" && rMode !== "none";
    const opcode = this.getCompareOpCode(expr.operator, useSpecialized);
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
        opcode = this.getType(expr.right)?.kinds === BOOL_BIT ? OpCodes.NOTB : OpCodes.NOTG;
        break;
      }
      case TokenType.MINUS: {
        const k = this.getType(expr.right)?.kinds;
        // Pure FLOAT only: NEGF does `-(x as number)` which crashes on
        // bigint. Int and bool go through NEGG, which dispatches on typeof.
        opcode = k !== undefined && k !== 0 && (k & ~FLOAT_BIT) === 0
          ? OpCodes.NEGF
          : OpCodes.NEGG;
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
    if (stmt.target instanceof ExprNS.Subscript) {
      const objResult = this.compile(stmt.target.value);
      const idxResult = this.compile(stmt.target.index);
      const valResult = this.compile(stmt.value);
      this.builder.emitNullary(OpCodes.STAG);
      this.builder.emitNullary(OpCodes.LGCU);
      return {
        maxStackSize: Math.max(
          objResult.maxStackSize,
          1 + idxResult.maxStackSize,
          2 + valResult.maxStackSize,
          1,
        ),
      };
    }

    const initResult = this.compile(stmt.value);
    this.emitStoreSymbol(stmt.target.name);

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
