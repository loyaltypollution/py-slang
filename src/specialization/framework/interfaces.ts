import type { ExprNS, StmtNS } from "../../ast-types";
import type { FunctionUnit } from "./function-unit";
import type { HintStore, OptimizationHint } from "./hint";
import type { SlotLookup } from "./slot-table";

/**
 * Result of a successful `StmtTransformRule.apply`. `replacements` is the
 * spliced-in statement list (empty = delete). `invalidate` lists other
 * scopes the rule mutated in the same operation — the worklist publishes
 * a `"structural"` dirty mark for each. Declared at rewrite time instead
 * of a separate `affectedScopes` callback so the cross-scope mutation is
 * tied to the exact apply that caused it.
 */
export interface StmtTransformApplyResult {
  readonly replacements: readonly StmtNS.Stmt[];
  readonly invalidate?: readonly (StmtNS.FileInput | StmtNS.FunctionDef)[];
}

export interface StmtTransformRule {
  readonly name: string;
  readonly level: "stmt";
  matches(stmt: StmtNS.Stmt, hints: HintStore): boolean;
  apply(stmt: StmtNS.Stmt, hints: HintStore): StmtTransformApplyResult;
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
 * the body). `apply` returns `true` if the AST changed, which triggers a
 * CFG rebuild and the next transform round.
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
   * If true, the worklist scheduler records `(scope, rule)` after the first
   * successful apply and short-circuits future matches/applies on the same
   * pair. The rule no longer needs a self-latch (e.g. a marker field in the
   * hint) to prevent re-firing — the framework enforces one-shot semantics.
   *
   * This separates non-monotone rules (whose apply would re-match forever
   * without a latch) from the monotone rules that `ScopeTransformRule`
   * models by default, and keeps the non-monotone-through-monotone
   * smuggling out of the rule's own `matches` predicate.
   *
   * **Scope of "once":** the latch lives for the lifetime of the worklist
   * and survives `rebuildAndReseed` (which is itself triggered by the
   * successful apply). Clearing the latch on rebuild would cause the rule
   * to re-fire on the next tick, defeating the point. This is intentional —
   * "fireOnce" means "once per (scope, rule) pair across the worklist's
   * lifetime", not "once per structural version".
   */
  readonly fireOnce?: boolean;
}

export type TransformRule = StmtTransformRule | ExprTransformRule | ScopeTransformRule;

/**
 * Expression-level dataflow analysis pass. The `name` doubles as the
 * hint-record field under which the analysis stores its lattice value. A
 * new analysis adds a pass (and an optional field on `OptimizationHint`)
 * and the framework picks it up. `latticeEquals` is declared directly on
 * each concrete pass — consumers that need hint-level equality route
 * through the worklist's private `hintFieldsEqual` (which dispatches
 * here via the `analysesByName` registry) rather than calling
 * pass-level equality directly.
 *
 * An `AnalysisPass<L>` runs as a Kildall fixpoint over basic blocks within
 * a `FunctionUnit`. For scope-level one-shot folds (call counts, purity
 * summaries), use `ScopePass` instead.
 */
export interface AnalysisPass<L> {
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
   * Fold a raw runtime value (pushed by an interpreter on a slot write) into
   * the node's hint. Must use `join` semantics — observations widen the set
   * of seen values, they never narrow static facts (narrowing would be
   * unsound for specialization consumers). Return `hint` unchanged when the
   * value is not useful for this analysis (e.g. ConstAnalysisPass ignores
   * non-primitive JS values rather than widening to TOP).
   *
   * Paired with `ObservationSink.observeWrite` on the worklist side: the
   * sink's `observeWrite` is the runtime *event*; this method is the
   * per-analysis *reaction* that lifts the raw value into the lattice and
   * merges it into the hint in one step.
   */
  observeWrite?(hint: OptimizationHint, rawValue: unknown): OptimizationHint;
}

/**
 * Scope-level, one-shot pass. Runs once per scope per generation, after
 * the expression-level `AnalysisPass` fixpoint has converged for that
 * scope. No lattice, no transfer function — reads converged expression
 * facts from `unit.analysisOuts` / `unit.hints` and/or buffered runtime
 * observations from `unit.callObservations`, and folds them into a
 * scope-level hint on `unit.funcAst.id`.
 *
 * Use when a fact is naturally a *summary over a whole scope* — call
 * counts, purity summaries, escape summaries — and a fixpoint would either
 * not converge (semiring increments on cycles) or adds no value over a
 * single walk.
 *
 * Registered on a worklist via `addScopePass`. Registration order is run
 * order.
 */
export interface ScopePass {
  readonly name: string;
  run(unit: FunctionUnit): void;
  /**
   * Hint field names this pass writes that expression-level `AnalysisPass`
   * transfers must NOT read. Populates a runtime guard (dev/test builds
   * only) that traps such reads inside `AnalysisPass.makeExprVisitor`
   * transfer functions — turning the currently-comment-only ordering
   * invariant (ScopePass outputs feed ScopeTransformRule / later
   * ScopePasses, not AnalysisPass) into a checked contract.
   */
  readonly writesFields?: readonly (keyof import("./hint").OptimizationHint)[];
}
