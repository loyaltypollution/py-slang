import type { ExprNS, StmtNS } from "../../ast-types";
import type { FunctionUnit } from "./function-unit";
import type { SlotLookup } from "./slot-table";
import type { HintStore, LatticeEquality, OptimizationHint } from "./hint";

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
   */
  readonly safeOnStack?: boolean;
}

export type TransformRule = StmtTransformRule | ExprTransformRule | ScopeTransformRule;

/**
 * An analysis pass. The `name` doubles as the hint-record field under
 * which the analysis stores its lattice value and as the registry key for
 * `HintStore.hintEquals` (via the inherited `LatticeEquality` surface).
 * This is the extensibility seam — a new analysis adds a module (and an
 * optional field on `OptimizationHint`) and the framework picks it up.
 */
export interface AnalysisModule<L> extends LatticeEquality {
  readonly name: string;
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

  /**
   * Optional runtime hook fired by the worklist on every `observeCall`
   * (before the callee's CFG is rebuilt and analyses re-seeded). Lets an
   * analysis accumulate per-scope call-site facts (e.g. memoization's
   * saturating call counter) keyed on the callee FunctionDef's hint without
   * shoehorning the update through the expression-level transfer function.
   */
  onCallObservation?(
    callerKey: StmtNS.FileInput | StmtNS.FunctionDef,
    calleeKey: StmtNS.FileInput | StmtNS.FunctionDef,
    calleeHints: HintStore,
  ): void;
}
