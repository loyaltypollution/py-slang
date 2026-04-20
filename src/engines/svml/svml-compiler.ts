import { ExprNS, StmtNS } from "../../ast-types";
import { Environment, FunctionEnvironments, Resolver } from "../../resolver";
import type { ConstLattice } from "../../specialization/const-analysis/lattice";
import type { TypeLattice } from "../../specialization/type-analysis/lattice";
import type { Unit } from "../../specialization/framework/function-unit";
import type { EntryGuard } from "../../specialization/entry-guards";
import type { DfaQuery } from "../../specialization/dfa-query";
import type { GuardRegistrar } from "../../specialization/framework/worklist";
import {
  constNarrowing,
  paramConstNarrowing,
  paramTypeNarrowing,
  returnKindNarrowing,
} from "../../specialization/framework/dfa-analyses";
import { ScopeIndexMap } from "./scope-index-map";
import {
  BOOL_BIT,
  CLOSURE_BIT,
  FLOAT_BIT,
  INT_BIT,
  NULL_BIT,
  STR_BIT,
  meet,
} from "../../specialization/type-analysis/lattice";
import { Token } from "../../tokenizer";
import { TokenType } from "../../tokens";
import { SVMLIRBuilder } from "./SVMLIRBuilder";
import { PRIMITIVE_FUNCTIONS } from "./builtins";
import OpCodes, { SVMLKindBits } from "./opcodes";
import { SVMLIR, SVMLProgram } from "./types";
import {
  FunctionRegistry,
  buildFunctionRegistry,
} from "../../specialization/framework/function-registry";

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
  /** Optional provenance hook: when set, each emitted guard publishes the
   *  speculative fact it's protecting so the engine can prune lineage-
   *  precisely on deopt (see `Worklist.widenGuard`). `undefined` means
   *  the engine will fall back to `widenUnitSpeculation` on violation. */
  private guardRegistrar: GuardRegistrar | undefined;
  private allowSpeculativeConditionGuards = true;
  private _scopeIndexMap?: ScopeIndexMap;
  /**
   * Shared canonical registry of function identity and slot layout. Built
   * once at top-level compiler construction from the AST (or supplied by the
   * caller so Worklist and compiler observe the same identity), inherited by
   * child compilers through `fromFunctionNode`. Transforms that structurally
   * add or remove function scopes must `mint`/`retire` through it — a missing
   * entry here throws at slot lookup, converting silent miscompiles into
   * loud failures.
   */
  private registry!: FunctionRegistry;

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
    guardRegistrar?: GuardRegistrar,
  ) {
    this.builder = builder;
    this.currentEnvironment = currentEnvironment;
    this.functionEnvironments = functionEnvironments;
    this.isTailCall = false;
    this.dfaQuery = dfaQuery;
    this.guardRegistrar = guardRegistrar;
  }

  /** Scope → function index map, populated during compilation via fromProgramUnit(). */
  get scopeIndexMap(): ScopeIndexMap | undefined {
    return this._scopeIndexMap;
  }

  private getType(node: ExprNS.Expr | StmtNS.Stmt): TypeLattice | undefined {
    return this.dfaQuery?.typeOf(node.id);
  }

  private getConst(node: ExprNS.Expr | StmtNS.Stmt): ConstLattice | undefined {
    return this.dfaQuery?.constOf(node.id);
  }

  /** Speculation is sound to emit only when the enclosing function is pure:
   *  a guard violation re-enters the call from the top, replaying any side
   *  effects that already happened. Pure callees have nothing to replay.
   *  Top-level FileInput is never speculated (re-running the script is too
   *  expensive and may have observable side effects). */
  private speculationAllowed(): boolean {
    const scope = this.builder.getScopeKey();
    if (!(scope instanceof StmtNS.FunctionDef)) return false;
    return this.dfaQuery?.isPureScope(scope.id) === true;
  }

  private static readonly NUMERIC_KIND_MASK = INT_BIT | FLOAT_BIT | BOOL_BIT;

  private isStaticallyNumeric(node: ExprNS.Expr): boolean {
    const k = this.getType(node)?.kinds;
    return k !== undefined && k !== 0 && (k & ~SVMLCompiler.NUMERIC_KIND_MASK) === 0;
  }

  private entryRequirementOf(token: Token): TypeLattice | undefined {
    const annotation = this.getTokenAnnotation(token);
    if (annotation.isPrimitive || annotation.envLevel !== 0) return undefined;
    return this.entryRequirementBySlot.get(annotation.slot);
  }

  private entryGuardedType(node: ExprNS.Expr | StmtNS.Stmt): TypeLattice | undefined {
    if (!(node instanceof ExprNS.Variable)) return undefined;
    const required = this.entryRequirementOf(node.name);
    if (required === undefined) return undefined;
    const staticType = this.getType(node);
    return staticType === undefined ? required : meet(staticType, required);
  }

  private entryGuardedNumeric(node: ExprNS.Expr): boolean {
    if (!this.speculationAllowed()) return false;
    const k = this.entryGuardedType(node)?.kinds;
    return k !== undefined && k !== 0 && (k & ~SVMLCompiler.NUMERIC_KIND_MASK) === 0;
  }

  /** Per-operand specialization decision. `"static"` = proven numeric by
   *  static analysis (emits F-opcode, no guard); `"none"` = generic opcode.
   *  Speculative numeric narrowing is disabled: ADDF vs ADDG in this
   *  interpreter differ by ~2 typeof checks per dispatch, which V8's
   *  optimizer closes via PIC/inlining; measured net speedup was ≤1%.
   *  The real JIT lever is dead-branch elimination (see visitIfStmt). */
  private numericMode(node: ExprNS.Expr): "static" | "entry-guarded" | "none" {
    if (this.isStaticallyNumeric(node)) return "static";
    return this.entryGuardedNumeric(node) ? "entry-guarded" : "none";
  }

  /** Slot key → expected const value, populated when visitAssignStmt emits
   *  a peek-guard verifying the RHS's speculative const. Reads of a slot
   *  tracked here are GUARANTEED to hold the recorded value at runtime,
   *  so any expression whose speculative const flows from these slots is
   *  const-pinned and can skip runtime evaluation entirely. This is the
   *  anchor that lets visitIfStmt drop the cond eval and dead arm. */
  private constGuardedSlots = new Map<string, number>();
  /** Entry-guarded parameter requirements for the current FunctionDef.
   *  Populated only when compiling a function under a return-kind speculation
   *  context whose `typeRequirementAnalysis` result is provable. */
  private entryRequirementBySlot = new Map<number, TypeLattice>();

  /** If the speculative const analysis has pinned `cond` to a concrete value AND
   *  speculation is allowed in this scope, return the truthiness; otherwise
   *  `undefined`. The compiler uses this in `visitIfStmt` to drop a dead arm
   *  at the IR level — the big DCE lever the JIT has over AOT, since the
   *  static const analysis cannot prove a parameter or cross-scope value
   *  constant without interprocedural inference. Static const is checked
   *  first so already-folded conditions return `undefined` here (visitIfStmt's
   *  static-fold path handles those).
   *
   *  Post-deopt soundness: when a guard fires, `Worklist.widenUnitSpeculation`
   *  retracts the unit's spec context to ROOT, so `speculativeConstOf` on the
   *  next compile returns the non-narrowed fact and this returns `undefined`.
   *  No separate blacklist gate required. */
  private speculativeConditionTruth(cond: ExprNS.Expr): boolean | undefined {
    if (!this.allowSpeculativeConditionGuards) return undefined;
    if (!this.speculationAllowed()) return undefined;
    // Skip if the static const analysis already proves it — no guard needed.
    const staticConst = this.getConst(cond);
    if (staticConst !== undefined && staticConst.tag === "const") return undefined;
    const spec = this.dfaQuery?.speculativeConstOf(cond.id);
    if (spec === undefined || spec.tag !== "const") return undefined;
    const v = spec.value;
    // Python truthiness over the values constOf can hold (number/bool/string).
    if (typeof v === "number") return v !== 0;
    if (typeof v === "boolean") return v;
    if (typeof v === "string") return v.length > 0;
    return undefined;
  }

  /**
   * Create SVMLCompiler from program AST.
   * Analysis pre-computed environments (from analyzeWithEnvironments) to avoid a second resolver run.
   * Analysis `registry` when sharing identity with a Worklist (JIT pipelines); omit to build one internally.
   */
  static fromProgram(
    program: StmtNS.FileInput,
    functionEnvironments?: FunctionEnvironments,
    registry?: FunctionRegistry,
  ): SVMLCompiler {
    if (!functionEnvironments) {
      const resolver = new Resolver("", program);
      functionEnvironments = resolver.resolveEnvironments(program);
    }
    const mainEnv = functionEnvironments.get(program);
    if (!mainEnv) {
      throw new Error("Main program environment not found");
    }
    const reg = registry ?? buildFunctionRegistry(program);
    const builder = new SVMLIRBuilder(0, reg.slotOfNode(program));
    builder.setScopeKey(program);
    const compiler = new SVMLCompiler(mainEnv, functionEnvironments, builder);
    compiler.registry = reg;
    return compiler;
  }

  static fromProgramUnit(
    program: StmtNS.FileInput,
    functionEnvironments: FunctionEnvironments,
    dfaQuery?: DfaQuery,
    registry?: FunctionRegistry,
    guardRegistrar?: GuardRegistrar,
  ): SVMLCompiler {
    const mainEnv = functionEnvironments.get(program);
    if (!mainEnv) {
      throw new Error("Main program environment not found");
    }
    const reg = registry ?? buildFunctionRegistry(program);
    const builder = new SVMLIRBuilder(0, reg.slotOfNode(program));
    builder.setScopeKey(program);
    const compiler = new SVMLCompiler(mainEnv, functionEnvironments, builder, dfaQuery, guardRegistrar);
    compiler.registry = reg;

    // Populate ScopeIndexMap eagerly so it is the source of truth for NEWC
    // emissions on the very first compile (and matches lookups during any
    // subsequent compileFunction). Only FunctionDef/FileInput qualify as
    // ScopeKeys — Lambda/MultiLambda carry indices but are not DFA units.
    compiler._scopeIndexMap = new ScopeIndexMap();
    for (const { node, slot } of reg.entries()) {
      if (node instanceof StmtNS.FileInput || node instanceof StmtNS.FunctionDef) {
        compiler._scopeIndexMap.register(node, slot);
      }
    }
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
    const childIndex = this.registry.slotOfNode(node);
    const builder = this.builder.createChildBuilder(numArgs, childIndex);
    // Only FunctionDef bodies are ScopeKeys; Lambda/MultiLambda are not DFA units.
    if (node instanceof StmtNS.FunctionDef) {
      builder.setScopeKey(node);
    }

    const compiler = new SVMLCompiler(
      nextEnvironment,
      this.functionEnvironments,
      builder,
      this.dfaQuery,
      this.guardRegistrar,
    );
    compiler._scopeIndexMap = this._scopeIndexMap;
    compiler.registry = this.registry;
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
    return this.registry.hasNode(scope) ? this.registry.slotOfNode(scope) : undefined;
  }

  /**
   * Recompile a single `Unit`'s body into fresh SVMLIR, without
   * touching any sibling builder. The returned IR's function index matches
   * what `compileProgram` would have assigned, so callers can splice it
   * into an existing `SVMLProgram` via `withSpecializedFunction(index, ir)`
   * and every `NEWC <index>` operand in unaffected siblings remains valid.
   *
   * Only `FunctionDef` bodies are supported (matches `Unit.funcAst`
   * excluding `FileInput`, which is the entry-point program and is rebuilt
   * via `compileProgram`). Lambdas are never `Unit` keys.
   */
  private static typeToGuardMask(v: TypeLattice): number | undefined {
    let mask = 0;
    if (v.kinds & INT_BIT) mask |= SVMLKindBits.NUMBER;
    if (v.kinds & FLOAT_BIT) mask |= SVMLKindBits.NUMBER;
    if (v.kinds & BOOL_BIT) mask |= SVMLKindBits.BOOLEAN;
    if (v.kinds & STR_BIT) mask |= SVMLKindBits.STRING;
    if (v.kinds & NULL_BIT) mask |= SVMLKindBits.NULL;
    if (v.kinds & CLOSURE_BIT) mask |= SVMLKindBits.CLOSURE;
    const unsupported = v.kinds & ~(INT_BIT | FLOAT_BIT | BOOL_BIT | STR_BIT | NULL_BIT | CLOSURE_BIT);
    return unsupported === 0 && mask !== 0 ? mask : undefined;
  }

  private emitLiteralGuardValue(value: unknown): boolean {
    if (value === null) {
      this.builder.emitNullary(OpCodes.LGCN);
      return true;
    }
    switch (typeof value) {
      case "boolean":
        this.builder.emitNullary(value ? OpCodes.LGCB1 : OpCodes.LGCB0);
        return true;
      case "number":
        if (Number.isInteger(value) && I32_MIN <= value && value <= I32_MAX) {
          this.builder.emitUnary(OpCodes.LGCI, value);
        } else {
          this.builder.emitUnary(OpCodes.LGCF64, value);
        }
        return true;
      case "string":
        this.builder.emitUnary(OpCodes.LGCS, value);
        return true;
      default:
        return false;
    }
  }

  private emitDirectEntryGuards(funcAst: StmtNS.FunctionDef, guards: ReadonlyArray<EntryGuard>): void {
    if (funcAst.body.length === 0 || guards.length === 0) return;
    for (const guard of guards) {
      if (guard.kind === "param-type") {
        if (SVMLCompiler.typeToGuardMask(guard.ty) === undefined) return;
      } else if (
        guard.value !== null &&
        typeof guard.value !== "boolean" &&
        typeof guard.value !== "number" &&
        typeof guard.value !== "string"
      ) {
        return;
      }
    }
    const guardNodeId = funcAst.body[0].id;
    for (const guard of guards) {
      this.builder.emitUnary(OpCodes.LDLG, guard.paramIndex);
      if (guard.kind === "param-type") {
        const mask = SVMLCompiler.typeToGuardMask(guard.ty)!;
        this.builder.emitBinary(OpCodes.GUARD_KIND, guardNodeId, mask);
        this.guardRegistrar?.registerGuard(guardNodeId, {
          narrowing: paramTypeNarrowing,
          key: `${funcAst.id}:${guard.paramIndex}`,
        });
        this.builder.emitNullary(OpCodes.POPG);
        continue;
      }
      this.emitLiteralGuardValue(guard.value);
      this.builder.emitNullary(OpCodes.EQG);
      this.builder.emitBinary(OpCodes.GUARD_TRUTHY, guardNodeId, 1);
      this.guardRegistrar?.registerGuard(guardNodeId, {
        narrowing: paramConstNarrowing,
        key: `${funcAst.id}:${guard.paramIndex}`,
      });
    }
  }

  private emitEntryRequirementGuards(funcAst: StmtNS.FunctionDef): void {
    if (funcAst.body.length === 0 || this.entryRequirementBySlot.size === 0) return;
    // All-or-nothing: if any provable requirement is unrepresentable as a
    // GUARD_KIND mask, abandon the whole set. A partial guard set would leave
    // the return-kind speculation unprotected on the skipped slot, which is
    // unsound for any consumer that baked the speculated return kind into
    // its own codegen (see DfaQuery.entryRequirementsOf contract).
    const masks: Array<[number, number]> = [];
    for (const [slot, req] of this.entryRequirementBySlot) {
      const mask = SVMLCompiler.typeToGuardMask(req);
      if (mask === undefined) return;
      masks.push([slot, mask]);
    }
    const guardNodeId = funcAst.body[0].id;
    for (const [slot, mask] of masks) {
      this.builder.emitUnary(OpCodes.LDLG, slot);
      this.builder.emitBinary(OpCodes.GUARD_KIND, guardNodeId, mask);
      this.guardRegistrar?.registerGuard(guardNodeId, {
        narrowing: returnKindNarrowing,
        key: funcAst.id,
      });
      this.builder.emitNullary(OpCodes.POPG);
    }
  }

  /** Compile a single FunctionDef unit.
   *  `specializedBody` — when provided, compiled in place of `funcAst.body`.
   *  The caller is responsible for ensuring the body is a valid speculative
   *  clone (NodeId-shadow policy, no topology insertion). */
  compileFunction(
    unit: Unit,
    specializedBody?: ReadonlyArray<StmtNS.Stmt>,
    directEntryGuards?: ReadonlyArray<EntryGuard>,
  ): SVMLIR {
    const funcAst = unit.funcAst;
    if (!(funcAst instanceof StmtNS.FunctionDef)) {
      throw new Error(
        "compileFunction only supports FunctionDef units; use compileProgram for FileInput",
      );
    }
    const nextEnvironment = this.functionEnvironments.get(funcAst);
    if (!nextEnvironment) {
      throw new Error("Function environment not found");
    }
    for (const param of funcAst.parameters) {
      nextEnvironment.lookupNameCurrentEnvWithError(param);
    }
    const index = this.registry.slotOfNode(funcAst);

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
      this.guardRegistrar,
    );
    subCompiler._scopeIndexMap = this._scopeIndexMap;
    subCompiler.registry = this.registry;
    subCompiler.allowSpeculativeConditionGuards = specializedBody === undefined;

    const slotMap = new Map<string, number>();
    subCompiler.envSlotMaps.set(nextEnvironment, slotMap);
    for (let i = 0; i < funcAst.parameters.length; i++) {
      slotMap.set(funcAst.parameters[i].lexeme, i);
    }
    subCompiler.envSlotCounters.set(nextEnvironment, numArgs);

    const entryReqs = this.dfaQuery?.entryRequirementsOf(funcAst.id);
    if (entryReqs !== undefined && entryReqs.unprovable.size === 0) {
      subCompiler.entryRequirementBySlot = new Map(entryReqs.provable);
    }

    subCompiler.emitDirectEntryGuards(funcAst, directEntryGuards ?? []);
    subCompiler.emitEntryRequirementGuards(funcAst);
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

  /** True when both operands are statically numeric — any subset of
   *  `INT_BIT | FLOAT_BIT | BOOL_BIT`. The F-opcodes at runtime `as number`
   *  both sides and dispatch plain JS `*`/`+`/…, which handles int, float,
   *  and bool identically (Python `bool <: int`, and JS coerces `true/false`
   *  to `1/0`). Admits the mixed bitmask produced by guard-narrowing. */
  private bothNumeric(left: ExprNS.Expr, right: ExprNS.Expr): boolean {
    const lk = this.getType(left)?.kinds;
    const rk = this.getType(right)?.kinds;
    if (lk === undefined || rk === undefined) return false;
    const NUMERIC = INT_BIT | FLOAT_BIT | BOOL_BIT;
    return lk !== 0 && (lk & ~NUMERIC) === 0 && rk !== 0 && (rk & ~NUMERIC) === 0;
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
        // Accept any subset of INT|FLOAT|BOOL — NEGF does `-(x as number)`
        // and is agnostic within the numeric family (JS coerces bool→0/1).
        const NUMERIC = INT_BIT | FLOAT_BIT | BOOL_BIT;
        opcode = k !== undefined && k !== 0 && (k & ~NUMERIC) === 0
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
    if (node instanceof StmtNS.FunctionDef) {
      const entryReqs = this.dfaQuery?.entryRequirementsOf(node.id);
      if (entryReqs !== undefined && entryReqs.unprovable.size === 0) {
        compiler.entryRequirementBySlot = new Map(entryReqs.provable);
      }
      compiler.emitEntryRequirementGuards(node);
    }
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

    // Record an observation write site at the STORE pc so the runtime can
    // push (scopeKey, rhsNode, value) into the reactive sink. Skip when the
    // RHS hint is already concrete (singleton type kind + known constVal) —
    // a runtime observation cannot refine it further, so the Map.get(pc) on
    // every STORE would be dead overhead.
    if (!isConcrete(this.getType(stmt.value), this.getConst(stmt.value))) {
      this.builder.recordWriteSite(stmt.value);
    }
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
    // Speculative dead-branch: if the speculative const analysis has pinned the
    // condition's value, emit `cond + GUARD_TRUTHY + only-the-taken-arm`.
    // The dead arm produces zero opcodes — the IR-level DCE that AOT cannot
    // replicate without interprocedural value inference. Deopt restores the
    // generic shape by context pruning (see Worklist.widenUnitSpeculation):
    // the retracted spec context makes speculativeConstOf return the
    // unpinned fact on the next compile, so this branch of visitIfStmt
    // falls through to the generic cond/branch emission below.
    const specTruth = this.speculativeConditionTruth(stmt.condition);
    if (specTruth !== undefined) {
      const testResult = this.compile(stmt.condition);
      this.builder.emitBinary(OpCodes.GUARD_TRUTHY, stmt.condition.id, specTruth ? 1 : 0);
      // Publish the speculative fact this guard protects — the engine traces
      // it back to load-bearing assumptions on deopt (see
      // `Worklist.widenGuard`). No-op when no registrar was supplied.
      this.guardRegistrar?.registerGuard(stmt.condition.id, {
        narrowing: constNarrowing,
        key: stmt.condition.id,
      });
      const taken = specTruth ? stmt.body : stmt.elseBlock;
      const takenResult = taken
        ? this.compileStatements(taken)
        : (() => {
            this.builder.emitNullary(OpCodes.LGCU);
            return { maxStackSize: 1 };
          })();
      return {
        maxStackSize: Math.max(testResult.maxStackSize, takenResult.maxStackSize),
      };
    }

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
