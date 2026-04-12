import type { TypeLattice } from "../type-analysis/lattice";
import type { ConstLattice } from "../const-analysis/lattice";
import type { ExprNS, StmtNS } from "../../ast-types";

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

// ── Built-in lattice equality helpers ────────────────────────────────────────

export function typeLatticeEquals(a: TypeLattice, b: TypeLattice): boolean {
  return (
    a === b ||
    (a.kinds === b.kinds && a.intRef === b.intRef && a.boolRef === b.boolRef && a.floatRef === b.floatRef)
  );
}

export function constLatticeEquals(a: ConstLattice, b: ConstLattice): boolean {
  return a === b || (a.tag !== "const" ? a.tag === b.tag : b.tag === "const" && a.value === b.value);
}

/**
 * Field-level equality: each known hint field has a known lattice equality.
 * Unknown fields fall back to strict `===` (conservative — over-invalidates).
 */
export function hintEquals(a: OptimizationHint, b: OptimizationHint): boolean {
  const names = new Set<string>([...Object.keys(a), ...Object.keys(b)]);
  for (const name of names) {
    const av = a[name];
    const bv = b[name];
    if (av === bv) continue;
    if (av === undefined || bv === undefined) return false;
    switch (name) {
      case "type":
        if (!typeLatticeEquals(av as TypeLattice, bv as TypeLattice)) return false;
        break;
      case "constVal":
        if (!constLatticeEquals(av as ConstLattice, bv as ConstLattice)) return false;
        break;
      default:
        // callCount, memoized, and any future scalar field fall through to ===.
        return false;
    }
  }
  return true;
}

/**
 * Map-based hint storage keyed by node.id. Analysis visitors call
 * `hints.get(node)` / `hints.set(node, hint)`. Equality on write suppresses
 * no-op updates.
 */
export class HintStore {
  private readonly map = new Map<number, OptimizationHint>();

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
    if (old !== undefined && hintEquals(old, hint)) return false;
    this.map.set(id, hint);
    return true;
  }

  [Symbol.iterator](): IterableIterator<[number, OptimizationHint]> {
    return this.map.entries();
  }
}
