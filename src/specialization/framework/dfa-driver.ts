import { ExprNS, StmtNS } from "../../ast-types";
import type { AnalysisModule, TransformRule } from "./interfaces";
import type { HintStore } from "./hint";
import type { SlotLookup } from "../types";
import { applyTransformPass } from "./transform";

/**
 * Generic per-function type environment: maps slot index → L.
 *
 * Slot indices are assigned by SVMLCompiler.getOrAssignSlot — the same numbering
 * used here ensures analysis and codegen agree on which variable is which.
 *
 * Reference equality is the fast path for lattice comparisons because
 * the lattice modules return frozen singletons. Identical lattice values are always
 * the same object. The leq-based path handles non-singleton join results.
 */
export class MutableEnv<L> {
  private slots: (L | undefined)[];

  constructor(initial: (L | undefined)[] = []) {
    this.slots = initial.slice();
  }

  get(slot: number): L | undefined {
    return this.slots[slot];
  }

  set(slot: number, val: L): void {
    this.slots[slot] = val;
  }

  snapshot(): MutableEnv<L> {
    return new MutableEnv(this.slots);
  }

  /**
   * In-place join: for each slot, replace with join(this[i], other[i]).
   * Used at merge points (if/else branches, loop header widening).
   */
  joinWith(other: MutableEnv<L>, joinFn: (a: L, b: L) => L): void {
    const len = Math.max(this.slots.length, other.slots.length);
    for (let i = 0; i < len; i++) {
      const a = this.slots[i];
      const b = other.slots[i];
      if (a !== undefined && b !== undefined) {
        this.slots[i] = joinFn(a, b);
      } else {
        this.slots[i] = a ?? b;
      }
    }
  }

  /**
   * Lattice equality: a == b iff leq(a,b) && leq(b,a).
   * Reference equality is used as a fast path since singletons are interned.
   */
  equals(other: MutableEnv<L>, leq: (a: L, b: L) => boolean): boolean {
    if (this.slots.length !== other.slots.length) return false;
    for (let i = 0; i < this.slots.length; i++) {
      const a = this.slots[i];
      const b = other.slots[i];
      if (a === b) continue; // fast path: same singleton reference
      if (a === undefined || b === undefined) return false;
      if (!leq(a, b) || !leq(b, a)) return false;
    }
    return true;
  }

  toArray(): (L | undefined)[] {
    return this.slots.slice();
  }
}

/**
 * DFA statement driver: implements StmtNS.Visitor<void>.
 *
 * Manages the type environment across control flow constructs and delegates
 * expression annotation to the visitor produced by module.makeExprVisitor().
 * The while-loop fixpoint replaces the legacy 2-pass widening hack with proper
 * convergence iteration.
 *
 * @typeParam L - The lattice element type for this analysis.
 */
class DFAStatementDriver<L> implements StmtNS.Visitor<void> {
  constructor(
    private typeEnv: MutableEnv<L>,
    private readonly hints: HintStore,
    private readonly slotLookup: SlotLookup,
    private readonly module: AnalysisModule<L>,
  ) {}

  private visitExpr(expr: ExprNS.Expr): L {
    // Fresh visitor snapshot: captures current typeEnv state at call time.
    const visitor = this.module.makeExprVisitor(
      this.hints,
      this.typeEnv.toArray(),
      this.slotLookup,
    );
    return expr.accept(visitor);
  }

  private visitBlock(stmts: StmtNS.Stmt[]): void {
    for (const stmt of stmts) {
      stmt.accept(this);
    }
  }

  visitAssignStmt(stmt: StmtNS.Assign): void {
    const val = this.visitExpr(stmt.value);
    if (!(stmt.target instanceof ExprNS.Variable)) return;
    const info = this.slotLookup(stmt.target.name);
    if (!info.isPrimitive && info.envLevel === 0) {
      this.typeEnv.set(info.slot, val);
    }
  }

  visitAnnAssignStmt(stmt: StmtNS.AnnAssign): void {
    const val = this.visitExpr(stmt.value);
    const info = this.slotLookup(stmt.target.name);
    if (!info.isPrimitive && info.envLevel === 0) {
      this.typeEnv.set(info.slot, val);
    }
  }

  visitIfStmt(stmt: StmtNS.If): void {
    this.visitExpr(stmt.condition);

    const saved = this.typeEnv.snapshot();

    this.visitBlock(stmt.body);
    const afterTrue = this.typeEnv.snapshot();

    this.typeEnv = saved;
    if (stmt.elseBlock) {
      this.visitBlock(stmt.elseBlock);
    }

    afterTrue.joinWith(this.typeEnv, this.module.join.bind(this.module));
    this.typeEnv = afterTrue;
  }

  visitWhileStmt(stmt: StmtNS.While): void {
    for (;;) {
      const stableEnv = this.typeEnv.snapshot();

      this.visitExpr(stmt.condition);
      this.visitBlock(stmt.body);

      const widened = stableEnv.snapshot();
      widened.joinWith(this.typeEnv, this.module.join.bind(this.module));

      if (widened.equals(stableEnv, this.module.leq.bind(this.module))) {
        this.typeEnv = widened;
        break;
      }

      this.typeEnv = widened;
    }
  }

  visitForStmt(stmt: StmtNS.For): void {
    const preLoopEnv = this.typeEnv.snapshot();

    this.visitExpr(stmt.iter);

    const info = this.slotLookup(stmt.target);
    if (!info.isPrimitive && info.envLevel === 0) {
      this.typeEnv.set(info.slot, this.module.top());
    }

    this.visitBlock(stmt.body);

    preLoopEnv.joinWith(this.typeEnv, this.module.join.bind(this.module));
    this.typeEnv = preLoopEnv;
  }

  visitFunctionDefStmt(_stmt: StmtNS.FunctionDef): void {}

  visitReturnStmt(stmt: StmtNS.Return): void {
    if (stmt.value) this.visitExpr(stmt.value);
  }

  visitSimpleExprStmt(stmt: StmtNS.SimpleExpr): void {
    this.visitExpr(stmt.expression);
  }

  visitFileInputStmt(stmt: StmtNS.FileInput): void {
    this.visitBlock(stmt.statements);
  }

  visitAssertStmt(stmt: StmtNS.Assert): void {
    this.visitExpr(stmt.value);
  }

  visitPassStmt(_stmt: StmtNS.Pass): void {}
  visitBreakStmt(_stmt: StmtNS.Break): void {}
  visitContinueStmt(_stmt: StmtNS.Continue): void {}
  visitGlobalStmt(_stmt: StmtNS.Global): void {}
  visitNonLocalStmt(_stmt: StmtNS.NonLocal): void {}
  visitFromImportStmt(_stmt: StmtNS.FromImport): void {}
}

export function runAnalysisPass<L>(
  stmts: StmtNS.Stmt[],
  module: AnalysisModule<L>,
  env: MutableEnv<L>,
  hints: HintStore,
  slotLookup: SlotLookup,
): void {
  const driver = new DFAStatementDriver<L>(env, hints, slotLookup, module);
  for (const stmt of stmts) {
    stmt.accept(driver);
  }
}

export function runMultiAnalysisPasses(
  stmts: StmtNS.Stmt[],
  analyses: Array<{ module: AnalysisModule<any>; env: MutableEnv<any> }>,
  hints: HintStore,
  slotLookup: SlotLookup,
): void {
  let anyChanged = true;
  while (anyChanged) {
    anyChanged = false;
    for (const entry of analyses) {
      const before = entry.env.snapshot();
      runAnalysisPass(stmts, entry.module, entry.env, hints, slotLookup);
      if (!entry.env.equals(before, entry.module.leq.bind(entry.module))) {
        anyChanged = true;
      }
    }
  }
}

/**
 * Run the static optimization pipeline:
 * analyze → transform → re-analyze, repeating until no transformation fires.
 *
 * Fresh MutableEnv instances are created per analysis per outer iteration so
 * stale env state from before a structural transform does not poison re-analysis.
 */
export function stabilizeStatic(
  stmts: StmtNS.Stmt[],
  analyses: AnalysisModule<any>[],
  transforms: TransformRule[],
  hints: HintStore,
  slotLookup: SlotLookup,
  maxIterations = 10,
): void {
  for (let iter = 0; iter < maxIterations; iter++) {
    const entries = analyses.map(module => ({ module, env: new MutableEnv() }));
    runMultiAnalysisPasses(stmts, entries, hints, slotLookup);

    let changed = false;
    for (const rule of transforms) {
      changed = applyTransformPass(stmts, rule, hints) || changed;
    }
    if (!changed) return;
  }

  // Iteration cap reached: run one final analysis pass
  const finalEntries = analyses.map(module => ({ module, env: new MutableEnv() }));
  runMultiAnalysisPasses(stmts, finalEntries, hints, slotLookup);
}
