import type { ExprNS, StmtNS } from "../../ast-types";
import type { TypeLattice } from "../type-analysis/lattice";
import type { ConstLattice } from "../const-analysis/lattice";

/**
 * Open record of analysis values keyed by `AnalysisModule.name`. Built-in
 * analyses write to the named fields below; a new analysis adds an
 * optional field here and exposes the same name on its module.
 */
export interface OptimizationHint {
  readonly [fieldName: string]: unknown;
  readonly type?: TypeLattice;
  readonly constVal?: ConstLattice;
  readonly callCount?: number;
  readonly memoized?: boolean;
}

/**
 * Minimal view of `AnalysisModule` needed for hint equality dispatch.
 * Declared here (rather than importing the full interface) so `hint.ts`
 * does not circularly depend on `interfaces.ts` / concrete analyses.
 */
export interface HintEqualsDispatcher {
  get(name: string): { latticeEquals(a: unknown, b: unknown): boolean } | undefined;
}

/**
 * Field-level equality over open `OptimizationHint` records. Each field's
 * lattice equality is dispatched through the analysis module registered
 * under that field's name; fields with no registered module default to
 * inequality (consistent with "we don't know the lattice, so assume any
 * difference is meaningful" — over-invalidates but never under-invalidates).
 *
 * The dispatcher is required: passing `undefined` would silently degrade
 * every non-`===` field to `false`, which is the γ-era monkey-patch this
 * rewrite is meant to retire. Callers that truly have no registry (a few
 * test merge-helpers) should construct an empty `Map`.
 */
export function hintEquals(
  a: OptimizationHint,
  b: OptimizationHint,
  byName: HintEqualsDispatcher,
): boolean {
  const names = new Set<string>([...Object.keys(a), ...Object.keys(b)]);
  for (const name of names) {
    const av = a[name];
    const bv = b[name];
    if (av === bv) continue;
    if (av === undefined || bv === undefined) return false;
    const mod = byName.get(name);
    if (!mod) return false;
    if (!mod.latticeEquals(av, bv)) return false;
  }
  return true;
}

/**
 * Map-based hint storage keyed by node.id. Analysis visitors call
 * `hints.get(node)` / `hints.set(node, hint)`. Equality on write suppresses
 * no-op updates via the injected `eq` callback — typically
 * `(a, b) => hintEquals(a, b, worklist.analysesByName)`.
 */
export class HintStore {
  private readonly map = new Map<number, OptimizationHint>();

  constructor(
    private readonly eq: (a: OptimizationHint, b: OptimizationHint) => boolean,
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
    if (old !== undefined && this.eq(old, hint)) return false;
    this.map.set(id, hint);
    return true;
  }

  [Symbol.iterator](): IterableIterator<[number, OptimizationHint]> {
    return this.map.entries();
  }
}
