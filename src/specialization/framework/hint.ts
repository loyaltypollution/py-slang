import type { ExprNS, StmtNS } from "../../ast-types";
import type { TypeLattice } from "../type-analysis/lattice";
import type { ConstLattice } from "../const-analysis/lattice";

/**
 * Open record of analysis values keyed by analysis name. Two algebras coexist
 * here; the framework does not distinguish them structurally, but the
 * distinction matters for reasoning:
 *
 *   - *Lattice* fields (e.g. `type`, `constVal`) — written by an
 *     `AnalysisPass` during DFA; compared via that pass's `latticeEquals`;
 *     propagated via `join` across CFG edges.
 *   - *Profile* fields (e.g. `callCount`) — written by a `ProfileObserver` or
 *     `ScopePass` from runtime/observation data; saturating semiring
 *     increments; compared via `===`.
 *
 * A new analysis adds an optional field here and exposes the same `name` on
 * its module.
 */
export interface OptimizationHint {
  readonly [fieldName: string]: unknown;
  readonly type?: TypeLattice;
  readonly constVal?: ConstLattice;
  readonly callCount?: number;
}

/**
 * Map-based hint storage keyed by node.id. Analysis visitors call
 * `hints.get(node)` / `hints.set(node, hint)`. Equality on write suppresses
 * no-op updates via the injected `eq` callback — the worklist passes a
 * closure over its own `analysesByName` registry; test harnesses that never
 * re-write a node pass `() => false`.
 */
export class HintStore {
  private readonly map = new Map<number, OptimizationHint>();

  constructor(private readonly eq: (a: OptimizationHint, b: OptimizationHint) => boolean) {}

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
    if (old !== undefined && this.eq(old, hint)) return false;
    this.map.set(id, hint);
    return true;
  }

  [Symbol.iterator](): IterableIterator<[number, OptimizationHint]> {
    return this.map.entries();
  }
}
