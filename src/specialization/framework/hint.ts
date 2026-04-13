import type { ExprNS, StmtNS } from "../../ast-types";
import type { TypeLattice } from "../type-analysis/lattice";
import type { ConstLattice } from "../const-analysis/lattice";

/**
 * Closed record of analysis values. Each field is written by a specific pass;
 * equality on a field is dispatched through the pass's `latticeEquals` via
 * the `fieldEq` map passed to `HintStore`. Unregistered fields fall back to
 * `===` (correct for primitive scope-level summaries like `pure` and
 * `callCount`).
 *
 * Two algebras coexist here:
 *   - *Lattice* fields (`type`, `constVal`) — written by an `AnalysisPass`
 *     during DFA.
 *   - *Scope-summary* fields (`callCount`, `pure`) — written by a
 *     `ScopePass` from runtime observations or a scope-level fold.
 */
export interface OptimizationHint {
  readonly type?: TypeLattice;
  readonly constVal?: ConstLattice;
  readonly callCount?: number;
  readonly pure?: boolean;
}

export type HintField = keyof OptimizationHint;

/** Equality on one hint field. Never called with `undefined` on either side. */
export type FieldEquals = (a: unknown, b: unknown) => boolean;

const DEFAULT_EQ: FieldEquals = (a, b) => a === b;

/**
 * Map-based hint storage keyed by node.id.
 *
 * Writes dedup via registered per-field equality: `setById` and `updateField`
 * return `true` iff the stored value changed. This is what lets the worklist
 * route `observeWrite` to `markDirty("data")` only on genuine change.
 */
export class HintStore {
  private readonly map = new Map<number, OptimizationHint>();

  constructor(
    private readonly fieldEq: ReadonlyMap<string, FieldEquals> = new Map(),
  ) {}

  get(node: ExprNS.Expr | StmtNS.Stmt): OptimizationHint | undefined {
    return this.map.get(node.id);
  }

  getById(id: number): OptimizationHint | undefined {
    return this.map.get(id);
  }

  set(node: ExprNS.Expr | StmtNS.Stmt, hint: OptimizationHint): boolean {
    return this.setById(node.id, hint);
  }

  setById(id: number, hint: OptimizationHint): boolean {
    const old = this.map.get(id);
    if (old !== undefined && this.hintsEqual(old, hint)) return false;
    this.map.set(id, hint);
    return true;
  }

  /**
   * Write a single field without allocating the cross-product spread at the
   * call site. Returns true iff the stored value changed. Prefer this over
   * `{ ...prev, [field]: v }` + `setById`.
   */
  updateField<K extends HintField>(
    id: number,
    field: K,
    value: NonNullable<OptimizationHint[K]>,
  ): boolean {
    const old = this.map.get(id);
    const prevVal = old?.[field];
    if (prevVal !== undefined) {
      const eq = this.fieldEq.get(field) ?? DEFAULT_EQ;
      if (eq(prevVal, value)) return false;
    }
    this.map.set(id, { ...(old ?? {}), [field]: value });
    return true;
  }

  [Symbol.iterator](): IterableIterator<[number, OptimizationHint]> {
    return this.map.entries();
  }

  private hintsEqual(a: OptimizationHint, b: OptimizationHint): boolean {
    const names = new Set<string>([...Object.keys(a), ...Object.keys(b)]);
    for (const name of names) {
      const av = (a as Record<string, unknown>)[name];
      const bv = (b as Record<string, unknown>)[name];
      if (av === bv) continue;
      if (av === undefined || bv === undefined) return false;
      const eq = this.fieldEq.get(name) ?? DEFAULT_EQ;
      if (!eq(av, bv)) return false;
    }
    return true;
  }
}
