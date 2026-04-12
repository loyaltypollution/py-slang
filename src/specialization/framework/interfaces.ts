import type { ExprNS, StmtNS } from "../../ast-types";
import type { FunctionUnit } from "./function-unit";
import type { SlotLookup } from "./slot-table";
import type { HintStore, OptimizationHint } from "./hint";

export interface StmtTransformRule {
  readonly name: string;
  readonly level: "stmt";
  matches(stmt: StmtNS.Stmt, hints: HintStore): boolean;
  /** Returns replacement statements. Empty array = delete the statement. */
  apply(stmt: StmtNS.Stmt, hints: HintStore): StmtNS.Stmt[];
  /**
   * Optional: additional scopes the worklist must rebuild after this rule
   * fires on `stmt`. Used by non-monotone transforms that mutate a child
   * scope's body from the parent's transform pass (e.g. memoization wrapping
   * a FunctionDef: the parent scope gets rebuilt automatically, but the
   * child's CFG / analysis sessions don't see the body mutation without an
   * explicit invalidation).
   */
  affectedScopes?(stmt: StmtNS.Stmt): readonly (StmtNS.FileInput | StmtNS.FunctionDef)[];
}

export interface ExprTransformRule {
  readonly name: string;
  readonly level: "expr";
  matches(expr: ExprNS.Expr, hints: HintStore): boolean;
  /** Returns replacement expression (1:1). */
  apply(expr: ExprNS.Expr, hints: HintStore): ExprNS.Expr;
}

/**
 * Scope-level transform. Runs once per transform round on a `FunctionUnit`
 * — the rule sees the whole scope (FileInput or FunctionDef) and can mutate
 * its body as a unit. Used by rules whose input is per-scope facts rather
 * than per-statement patterns (e.g. memoization: the count that gates
 * wrapping lives on the FunctionDef's own hint, not on any statement inside
 * the body).
 *
 * `apply` returns the set of additional scopes the worklist should
 * invalidate after the rule fires — typically `[]` since mutating the
 * unit's own body already triggers a rebuild of its CFG via
 * `structuralVersion++`.
 */
export interface ScopeTransformRule {
  readonly name: string;
  readonly level: "scope";
  matches(unit: FunctionUnit): boolean;
  /**
   * Mutate `unit.funcAst` / `unit.hints` in place. Return `true` if the AST
   * changed (triggers CFG rebuild + next transform round).
   */
  apply(unit: FunctionUnit): boolean;
  /**
   * Pin-gate layer 1/3 (rule level — "is this transform safe against a
   * live frame?"). Default: false (pinned scopes are skipped).
   *
   * If true, this rule may fire on a scope that is currently pinned
   * (activeScopes.has(scopeKey)). The contract the rule promises: the
   * mutation only affects *future* calls into the scope — existing on-stack
   * frames must be unaffected. The interpreter copies `fd.body` at call
   * time, so mutating `fd.body` is safe-on-stack as long as no in-flight
   * reference reads from it. Rules that rewrite via splice (e.g. memoization
   * prepending a cache-check prelude) satisfy this.
   *
   * Without this flag, a recursive function's transforms are parked for the
   * entire duration of the outermost call — which for self-recursive
   * workloads (fib) means transforms never fire until after the program
   * completes, defeating the point of runtime specialization.
   *
   * Sister layers gate the same concern at different tiers (each is a
   * separate opt-in; none subsumes another):
   *   - `StateDeltaStrategy.canInstallOnStack` (osr.ts) — strategy level.
   *     "Is the state-delta installation technique safe against a live
   *     frame of this scope?" Whole-function IR swap: safe (frames hold
   *     direct refs). In-place operand patches: unsafe.
   *   - `SVMLInterpreter.patchFunction`'s `allowOnStack` param — engine
   *     level. Bypasses the defensive live-frame assertion when the
   *     strategy above has explicitly acknowledged safety.
   *
   * The three-layer split compensates for the absence of a
   * Truffle-Assumption / explicit deopt mechanism. A descriptor-indirection
   * refactor could collapse layers 2 and 3 (the strategy would always
   * swap a descriptor pointer rather than a raw IR slot), but that
   * refactor has not landed — do not collapse.
   */
  readonly safeOnStack?: boolean;

  /**
   * If true, the worklist scheduler records `(scope, rule)` after the first
   * successful apply and short-circuits future matches/applies on the same
   * pair. The rule no longer needs a self-latch (e.g. a marker field in the
   * hint) to prevent re-firing — the framework enforces one-shot semantics.
   *
   * This separates non-monotone rules (whose apply would re-match forever
   * without a latch) from the monotone rules that `ScopeTransformRule`
   * models by default, and keeps the non-monotone-through-monotone
   * smuggling out of the rule's own `matches` predicate.
   */
  readonly fireOnce?: boolean;
}

export type TransformRule = StmtTransformRule | ExprTransformRule | ScopeTransformRule;

/**
 * An analysis pass. The `name` doubles as the hint-record field under
 * which the analysis stores its lattice value. A new analysis adds a
 * module (and an optional field on `OptimizationHint`) and the framework
 * picks it up. `latticeEquals` is declared directly on each concrete
 * module — consumers that need equality route through `hintEquals` rather
 * than calling module-level equality.
 */
export interface AnalysisModule<L> {
  readonly name: string;
  latticeEquals(a: unknown, b: unknown): boolean;
  top(): L;
  bottom(): L;
  join(a: L, b: L): L;
  meet(a: L, b: L): L;
  leq(a: L, b: L): boolean;
  readonly mergeKind: "may" | "must";
  readonly direction: "forward" | "backward";

  /**
   * Create the expression-level visitor for this analysis. The DFA driver
   * calls this per expression sub-tree; the returned visitor reads from
   * `env` and writes computed facts to `hints`.
   */
  makeExprVisitor(
    hints: HintStore,
    env: { get(slot: number): L | undefined },
    slotLookup: SlotLookup,
  ): ExprNS.Visitor<L>;

  /**
   * Map a raw runtime value (pushed by an interpreter on a slot write) to a
   * lattice element of this analysis. Return `undefined` to ignore the
   * value (e.g. ConstAnalysisModule returns `undefined` for non-primitive
   * JS values rather than widening the hint to TOP).
   */
  observeValue?(rawValue: unknown): L | undefined;

  /**
   * Merge a lattice element produced by `observeValue` into the node's
   * hint. Must use `join` semantics — observations widen the set of seen
   * values, they never narrow static facts (narrowing would be unsound for
   * specialization consumers).
   */
  mergeIntoHint?(hint: OptimizationHint, value: L): OptimizationHint;
}

/**
 * Profile-style runtime observer. Unlike `AnalysisModule`, a `CallObserver`
 * does not participate in any lattice / transfer / visitor path — it only
 * reacts to `observeCall` dispatch. Use for side-table counters and other
 * non-dataflow facts that would otherwise be smuggled through a dummy
 * `AnalysisModule` (e.g. the memoization saturating call counter).
 *
 * Registered on a worklist via `addCallObserver`.
 */
export interface CallObserver {
  onCallObservation(
    callerKey: StmtNS.FileInput | StmtNS.FunctionDef,
    calleeKey: StmtNS.FileInput | StmtNS.FunctionDef,
    calleeHints: HintStore,
  ): void;
}
